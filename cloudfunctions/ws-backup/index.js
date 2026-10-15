// cloudfunctions/ws-backup/index.js
// 定时自动备份 + 异地留存 worker（缺口 B5 的最后一段管道）
//
// 背景：后台「数据与备份」面板已经能**手动**导出（admin_export）、上传到云存储、
// 登记清单、删除记录。但手动意味着「要靠人记得点」，而且落点还是本站自己的
// runtime 存储桶 —— 同一朵云、同一个环境，数据仍只有一份，谈不上备份。
//
// 本函数补上两件缺失的事：
//   1. **定时**：每天定点自动做一次快照（云端没有 pg_cron，只能靠云函数的定时触发器）
//   2. **异地**：把同一份 JSON 再投递到站外目标（Webhook / S3 兼容对象存储），
//      这样即便本站云环境整块丢失，也还有一份在别处
//
// 数据流
//   定时触发 → backup_worker_config(secret) 取策略
//     → admin_export 无权限？worker 不是管理员 → 改用 backup_export(secret)（本次同补）
//     → 序列化 JSON
//     → 【本站】POST /.cloud/storage/... 存进 runtime 桶（可选，见 BACKUP_STORE_LOCAL）
//     → 【异地】按 offsite 策略投递：webhook / s3
//     → backup_snapshot_record(secret, ...) 登记（含异地结果）
//     → backup_prune(secret, keep) 按保留份数裁剪，并删掉被裁掉的本地文件
//     → backup_worker_beat(secret, status) 心跳
//
// 为什么导出要新开一个 backup_export：admin_export 内部判 is_admin()，
// 而 worker 是服务端匿名调用（没有 JWT），一定为 false。
// 不能为了省事把 admin_export 的判权限放宽 —— 那等于把全量数据导出的口子开给所有人。
// 正确做法是另开一条**只认共享密钥**的通道，这也是本仓 notify worker 的一贯口径。
//
// 环境变量（必需）
//   WS_BLOG_ENDPOINT      站点域名，默认 https://ws-blog.app.workbuddy.host
//   WS_BLOG_ACCESS_KEY    站点发布密钥（wbpk_ 开头，公开值）
//   BACKUP_WORKER_SECRET  共享密钥，必须与后台「数据与备份」面板里的备份密钥一致
//
// 环境变量（异地留存，按 backup.offsite 策略取用）
//   BACKUP_WEBHOOK_URL    offsite=webhook 时的目标地址（收到 JSON POST）
//   BACKUP_S3_ENDPOINT    offsite=s3 时的 S3 兼容端点，如 https://s3.example.com
//   BACKUP_S3_BUCKET / BACKUP_S3_REGION / BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY
//   BACKUP_S3_PREFIX      对象前缀，默认 backups/
//
// 环境变量（本站留存）
//   BACKUP_STORE_LOCAL    'true' 才在站点 runtime 桶留副本。**默认关**：
//                         它落在同一朵云、同一个环境，对「备份」没有价值（见 storeLocal 说明）
//
// 人工触发（调试）：{"action":"probe"} 只做配置体检，不导出、不投递。

const pg = require('./pgrest.js');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const REQUEST_TIMEOUT = 30000;
/* 导出并发量大时 JSON 会不小；gzip 后通常只有 1/8。
 * 投递给外部目标时优先发压缩版（省流量、也避免部分网关的 body 上限）。 */
const GZIP = process.env.BACKUP_GZIP !== 'false';

/* ---------------- 工具 ---------------- */

function str(v) { return v === null || v === undefined ? '' : String(v); }

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

/** 发一个请求，返回 {ok, status, detail} */
function request(url, opts, body) {
  return new Promise(function (resolve) {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      resolve({ ok: false, detail: 'bad_url' });
      return;
    }
    const lib = target.protocol === 'http:' ? http : https;
    const headers = Object.assign({
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'ws-backup/1.0'
    }, (opts && opts.headers) || {});
    const req = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: (opts && opts.method) || 'POST',
      headers: headers,
      timeout: REQUEST_TIMEOUT
    }, function (res) {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          detail: String(b).slice(0, 200)
        });
      });
    });
    req.on('error', function (e) { resolve({ ok: false, detail: String(e.message).slice(0, 200) }); });
    req.on('timeout', function () { this.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

/** 把导出对象压成 Buffer（gzip 时顺便给出正确扩展名） */
function encodePayload(obj) {
  const json = JSON.stringify(obj);
  if (!GZIP) return { buf: Buffer.from(json, 'utf8'), ext: '.json', encoding: 'identity' };
  return { buf: zlib.gzipSync(Buffer.from(json, 'utf8')), ext: '.json.gz', encoding: 'gzip' };
}

/* ---------------- 异地投递 ---------------- */

/** Webhook：把整份 JSON（或 gzip 流）POST 出去，带 HMAC 签名供对端验真 */
async function deliverWebhook(url, payload, meta, secret) {
  if (!url) return { ok: false, detail: 'no_url' };
  const headers = {
    'Content-Type': 'application/json',
    'Content-Encoding': payload.encoding,
    'X-WS-Backup-Kind': str(meta.kind),
    'X-WS-Backup-At': str(meta.at),
    'X-WS-Backup-Name': str(meta.name)
  };
  headers['X-WS-Signature'] = 'sha256=' +
    crypto.createHmac('sha256', secret).update(payload.buf).digest('hex');
  const res = await request(url, { headers: headers }, payload.buf);
  return res.ok ? { ok: true, detail: 'ok:webhook' }
    : { ok: false, detail: 'failed:webhook ' + (res.status || '') + ' ' + (res.detail || '') };
}

/* --------- S3 兼容对象存储（AWS Signature V4，只用内置 crypto 手搓） ---------
 * 为什么不用 @aws-sdk：本函数的定位是「一个文件、零外部依赖也能跑」，
 * 而且我们只需要最简单的 PUT Object 一个动作。SigV4 的算法是公开且稳定的。
 */

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

async function deliverS3(cfg, payload, meta) {
  const endpoint = str(process.env.BACKUP_S3_ENDPOINT).replace(/\/+$/, '');
  const bucket = str(process.env.BACKUP_S3_BUCKET);
  const region = str(process.env.BACKUP_S3_REGION) || 'us-east-1';
  const accessKey = str(process.env.BACKUP_S3_ACCESS_KEY);
  const secretKey = str(process.env.BACKUP_S3_SECRET_KEY);
  const prefix = str(process.env.BACKUP_S3_PREFIX) || 'backups/';

  if (!endpoint || !bucket || !accessKey || !secretKey) {
    return { ok: false, detail: 'failed:s3 配置不全（endpoint/bucket/access_key/secret_key 至少缺一）' };
  }

  const key = prefix + meta.name;
  const target = new URL(endpoint);
  /* path-style 寻址（endpoint/bucket/key）：最兼容，MinIO / 阿里 OSS / 腾讯 COS 都吃 */
  const canonicalUri = '/' + bucket + '/' + key.split('/').map(encodeURIComponent).join('/');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20261015T030000Z
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256hex(payload.buf);
  const signedHeaders = 'content-encoding;content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders =
    'content-encoding:' + payload.encoding + '\n' +
    'content-type:application/json\n' +
    'host:' + target.host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n';
  const canonicalRequest = [
    'PUT', canonicalUri, '',
    canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');

  const scope = dateStamp + '/' + region + '/s3/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)
  ].join('\n');

  let signingKey = hmac('AWS4' + secretKey, dateStamp);
  signingKey = hmac(signingKey, region);
  signingKey = hmac(signingKey, 's3');
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  const res = await request(endpoint + canonicalUri, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': payload.encoding,
      'Authorization': authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate
    }
  }, payload.buf);

  return res.ok ? { ok: true, detail: 'ok:s3' }
    : { ok: false, detail: 'failed:s3 ' + (res.status || '') + ' ' + (res.detail || '') };
}

/* ---------------- 本站留存 ---------------- */

/**
 * 把备份存进本站 runtime 存储桶。
 *
 * ⚠️ 实测结论（2026-10-15）：**这条路当前走不通，已默认关闭**（见 BACKUP_STORE_LOCAL）。
 * storage 的写接口与数据库 REST 的鉴权方式不同 —— 只带 publishableKey 会被拒：
 *   401 MISSING_CREDENTIALS "Credentials missing"
 * 前端 SDK 是**两个头**并用：`x-wb-webapp-access-key` + `Authorization: Bearer <token>`，
 * 后者要先用 anonymousTokenProvider 换匿名令牌（见 vendor/cloud-sdk.js 的 createCloudFetch）。
 *
 * 但更关键的是**架构上的判断**：就算把令牌链路补通，这里存下的东西仍在
 * **同一朵云、同一个环境、同一个桶** —— 云环境整块丢失时它一起没。
 * 所以它对「备份」几乎没有价值，只适合当「顺手留一份」的缓存。
 *
 * 与其花力气把一个没有备份价值的功能修通，不如默认关掉，
 * 让「异地」（Webhook / S3）成为唯一真实的副本去向 —— 这也是 B5 的本意。
 * 需要时把 BACKUP_STORE_LOCAL 设回 true 并补上匿名令牌即可，代码保留。
 */
async function storeLocal(payload, meta) {
  const endpoint = pg.endpoint;
  const key = str(process.env.WS_BLOG_ACCESS_KEY);
  const path = 'shared/ws-backup/' + meta.name;
  const url = endpoint + '/.cloud/storage/object/runtime/' +
    path.split('/').map(encodeURIComponent).join('/');

  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': payload.encoding,
      'x-upsert': 'true',
      'x-wb-webapp-access-key': key
    }
  }, payload.buf);

  if (!res.ok) return { ok: false, path: path, url: '', detail: res.status + ' ' + res.detail };
  return {
    ok: true,
    path: path,
    url: endpoint + '/.cloud/storage/object/public/runtime/' +
      path.split('/').map(encodeURIComponent).join('/'),
    detail: 'ok'
  };
}

/* ---------------- 入口 ---------------- */

exports.main = async function (event) {
  const action = event && event.action ? event.action : 'snapshot';
  const secret = str(process.env.BACKUP_WORKER_SECRET).trim();

  if (!pg.configured()) {
    return {
      ok: false,
      code: 'CLOUD_NOT_CONFIGURED',
      message: '缺少 WS_BLOG_ACCESS_KEY（或 WS_BLOG_ENDPOINT），无法访问站点云数据库。'
    };
  }
  if (!secret) {
    return {
      ok: false,
      code: 'NO_WORKER_SECRET',
      message: '缺少 BACKUP_WORKER_SECRET：请把后台「数据与备份」面板里的备份密钥填进本函数的环境变量。'
    };
  }

  /* 1. 取策略（顺带验密钥：密钥不对这里就 forbidden，后面都不用做了） */
  let cfgRes;
  try {
    cfgRes = await pg.rpc('backup_worker_config', { p_secret: secret });
  } catch (e) {
    return { ok: false, code: 'CONFIG_FAILED', message: String((e && e.message) || e) };
  }
  if (!cfgRes || cfgRes.ok !== true) {
    return {
      ok: false,
      code: 'SECRET_REJECTED',
      message: '共享密钥不被接受：函数里的 BACKUP_WORKER_SECRET 与后台「数据与备份」面板里的备份密钥不一致。'
    };
  }

  const cfg = cfgRes.config || {};
  const offsite = str(cfg.offsite) || 'off';
  const probe = {
    endpoint: pg.endpoint,
    enabled: cfg.enabled === true,
    hour: cfg.hour,
    kind: cfg.kind,
    keep: cfg.keep,
    offsite: offsite,
    offsiteConfigured: (offsite === 'webhook' && !!process.env.BACKUP_WEBHOOK_URL) ||
      (offsite === 's3' && !!(process.env.BACKUP_S3_ENDPOINT && process.env.BACKUP_S3_BUCKET)),
    /* 默认 false：本站留存不构成备份（同云同环境），详见 storeLocal 上方说明 */
    storeLocal: process.env.BACKUP_STORE_LOCAL === 'true',
    gzip: GZIP
  };

  if (action === 'probe') {
    await beat(secret, 'probe', null);
    return { ok: true, action: 'probe', config: probe };
  }

  if (cfg.enabled !== true) {
    await beat(secret, 'disabled', '策略里 backup.enabled=false，跳过');
    return { ok: true, action: 'snapshot', skipped: 'disabled', config: probe };
  }

  /* 2. 导出（backup_export 只认共享密钥，worker 拿不到管理员身份） */
  const kind = str(cfg.kind) || 'all';
  let payload;
  try {
    payload = await pg.rpc('backup_export', { p_secret: secret, p_kind: kind });
  } catch (e) {
    await beat(secret, 'export_error', String((e && e.message) || e).slice(0, 300));
    return { ok: false, code: 'EXPORT_FAILED', message: String((e && e.message) || e) };
  }
  if (!payload || payload.ok !== true) {
    await beat(secret, 'export_rejected', JSON.stringify(payload || {}).slice(0, 300));
    return { ok: false, code: 'EXPORT_REJECTED', payload: payload };
  }

  const counts = payload.counts || {};
  const encoded = encodePayload(payload);
  const name = 'wsblog-' + kind + '-' + stamp() + encoded.ext;
  const meta = { kind: kind, at: new Date().toISOString(), name: name };

  /* 3. 本站留存（默认**关**：详见 storeLocal 上方的说明 —— 它不构成备份） */
  const wantLocal = process.env.BACKUP_STORE_LOCAL === 'true';
  let local = { ok: false, path: '', url: '', detail: 'skipped:local_off' };
  if (wantLocal) {
    try {
      local = await storeLocal(encoded, meta);
    } catch (e) {
      local = { ok: false, path: '', url: '', detail: String((e && e.message) || e) };
    }
  }

  /* 4. 异地投递 */
  let remote = { ok: false, detail: 'skipped:off' };
  try {
    if (offsite === 'webhook') {
      remote = await deliverWebhook(process.env.BACKUP_WEBHOOK_URL, encoded, meta, secret);
    } else if (offsite === 's3') {
      remote = await deliverS3(cfg, encoded, meta);
    }
  } catch (e) {
    remote = { ok: false, detail: 'failed:' + String((e && e.message) || e).slice(0, 180) };
  }

  /* 5. 登记。path 优先记本站路径；没留本站就记异地标识，方便后台看出东西在哪 */
  const recordPath = local.ok ? local.path : ('offsite:' + offsite + '/' + name);
  const offsiteState = offsite === 'off'
    ? 'off（未启用异地留存）'
    : (remote.ok ? remote.detail : remote.detail);

  let recorded = null;
  try {
    recorded = await pg.rpc('backup_snapshot_record', {
      p_secret: secret,
      p_kind: kind,
      p_path: recordPath,
      p_url: local.url || '',
      p_size: encoded.buf.length,
      p_row_counts: counts,
      p_note: offsite === 'off' ? '定时快照（未异地）' : '定时快照 + 异地',
      p_offsite: offsite,
      p_offsite_state: offsiteState
    });
  } catch (e) {
    await beat(secret, 'record_error', String((e && e.message) || e).slice(0, 300));
    return { ok: false, code: 'RECORD_FAILED', message: String((e && e.message) || e) };
  }

  /* 6. 裁剪（超出保留份数的最旧记录；顺便报告哪些本地文件可以删了） */
  let pruned = { removed: 0, paths: [] };
  try {
    const p = await pg.rpc('backup_prune', { p_secret: secret, p_keep: Number(cfg.keep) || 14 });
    if (p && p.ok === true) pruned = { removed: p.removed || 0, paths: p.paths || [] };
  } catch (e) {
    pruned = { removed: 0, paths: [], error: String((e && e.message) || e).slice(0, 160) };
  }

  /* 三态，语义互斥、后台一眼能读：
   *   ok                  —— 至少留下了一个副本，且异地（若启用）也投递成功
   *   ok_offsite_failed   —— **主流程成功**（快照已登记、数据有用），只是异地那一路没投出去。
   *                          刻意不并入 failed：异地失败不该把「这次备份白做了」误报给后台，
   *                          但它必须显眼，所以单独一态，并在心跳备注里写明原因。
   *   failed              —— 本站留存失败，且异地要么没启用、要么也失败了：这一轮没有任何副本落地。
   *  （登记失败 / 导出失败在前面就直接 return 了，所以走到这里的 failed 只可能是「没副本」。）
   */
  const remoteOn = offsite !== 'off';
  const anyCopy = local.ok || (remoteOn && remote.ok);
  let status;
  if (!anyCopy) {
    status = 'failed';
  } else if (remoteOn && !remote.ok) {
    status = 'ok_offsite_failed';
  } else {
    status = 'ok';
  }
  await beat(secret, status,
    '本地 ' + (local.ok ? 'ok' : local.detail) + ' | 异地 ' + remote.detail +
    ' | 裁剪 ' + pruned.removed);

  return {
    ok: true,
    action: 'snapshot',
    kind: kind,
    name: name,
    bytes: encoded.buf.length,
    encoding: encoded.encoding,
    counts: counts,
    local: { ok: local.ok, path: local.path, detail: local.detail },
    offsite: { mode: offsite, ok: remote.ok, detail: remote.detail },
    recorded: recorded,
    pruned: pruned,
    config: probe
  };
};

/** 心跳：静默定时任务必须留痕（后台据此显示「正常 / 已停止」）。密钥不对时写不进去。 */
async function beat(secret, status, note) {
  try {
    return await pg.rpc('backup_worker_beat', {
      p_secret: secret,
      p_status: status,
      p_note: note ? String(note).slice(0, 300) : null
    });
  } catch (e) {
    return null;
  }
}
