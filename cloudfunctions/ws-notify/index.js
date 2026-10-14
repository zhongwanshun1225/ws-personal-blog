// cloudfunctions/ws-notify/index.js
// 站外通知投递 worker（缺口 B3 的最后一段管道）
//
// 背景：站内通知中心（notifications）+ 发件箱队列（notify_outbox）+ 五套邮件模板
// 与后台队列面板都已经就绪，缺的是「把队列真的发出去」的进程。本函数补上它。
//
// 数据流
//   notifications 有插入 → 触发器 outbox_from_notification() → notify_outbox 入队
//   → 本函数（定时每 5 分钟）先读投递配置，有渠道才领取 → 投递（Webhook / SMTP）
//   → 回执 sent_at 或 last_error（失败按 5/10/15… 分钟退避，最多 8 次）
//
// 「先读配置再领取」是刻意的：领取会消耗尝试次数，若此时还没配好投递渠道，
// 队列会被无意义地烧到 8 次上限、全变成「失败」。没有渠道时直接跳过，不碰队列。
//
// 投递配置（webhook 地址 / mail.enabled / 站点名）**不从设置表直接读** ——
// webhook 地址属敏感信息，不该走匿名可读的设置视图；由 notify_worker_config /
// notify_outbox_claim 用共享密钥证明身份后代读。
//
// 环境变量
//   WS_BLOG_ENDPOINT      站点域名，默认 https://ws-blog.app.workbuddy.host
//   WS_BLOG_ACCESS_KEY    站点发布密钥（wbpk_ 开头，公开值）
//   NOTIFY_WORKER_SECRET  共享密钥，必须与后台「通知」面板里的投递密钥一致
//   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / MAIL_FROM / MAIL_TO
//                         仅在启用邮件投递时需要
//
// 人工触发（调试）：{"action":"probe"} 只做配置体检，不领取、不投递。

const pg = require('./pgrest.js');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const DEFAULT_LIMIT = Number(process.env.WS_NOTIFY_LIMIT) || 20;
const REQUEST_TIMEOUT = 10000;

/* ---------------- 工具 ---------------- */

function str(v) { return v === null || v === undefined ? '' : String(v); }

/** POST 一个 JSON 到外部 URL，返回 {ok, status, detail} */
function postJson(url, payload, headers) {
  return new Promise(function (resolve) {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      resolve({ ok: false, detail: 'bad_url' });
      return;
    }
    const body = JSON.stringify(payload);
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'ws-notify/1.0'
      }, headers || {}),
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
    req.on('error', function (e) { resolve({ ok: false, detail: String(e.message) }); });
    req.on('timeout', function () { this.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

/** 惰性加载 nodemailer：没装依赖时退化为「仅 Webhook」，不影响函数启动 */
let mailerLib = null;
let mailerTried = false;
function getMailer() {
  if (mailerTried) return mailerLib;
  mailerTried = true;
  try {
    mailerLib = require('nodemailer');
  } catch (e) {
    mailerLib = null;
  }
  return mailerLib;
}

function normalizeConfig(raw) {
  const c = raw || {};
  return {
    webhookUrl: str(c.webhook_url).trim(),
    webhookKind: str(c.webhook_kind) || 'auto',
    mailEnabled: c.mail_enabled === true || str(c.mail_enabled) === 'true',
    siteTitle: str(c.site_title) || 'WS Blog'
  };
}

function mailReady(cfg) {
  return !!(cfg.mailEnabled && process.env.SMTP_HOST && process.env.MAIL_TO && getMailer());
}

/* ---------------- 投递 ---------------- */

/** 投递一条：只要有一个渠道成功就算成功；全失败时把原因带回去 */
async function deliver(row, cfg, secret) {
  const errors = [];
  let tried = 0;

  if (cfg.webhookUrl) {
    tried++;
    const payload = {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      created_at: row.created_at,
      site: cfg.siteTitle
    };
    const signature = 'sha256=' +
      crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
    const res = await postJson(cfg.webhookUrl, payload, {
      'X-WS-Event': str(row.kind),
      'X-WS-Signature': signature
    });
    if (res.ok) return { ok: true, via: 'webhook' };
    errors.push('webhook ' + (res.status || '') + ' ' + (res.detail || ''));
  }

  if (mailReady(cfg)) {
    tried++;
    try {
      const mailer = getMailer();
      const transport = mailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 465),
        secure: str(process.env.SMTP_SECURE) !== 'false',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
          : undefined
      });
      await transport.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER || cfg.siteTitle,
        to: process.env.MAIL_TO,
        subject: row.title,
        text: (row.body || '') + (row.link ? '\n\n' + row.link : '')
      });
      return { ok: true, via: 'mail' };
    } catch (e) {
      errors.push('mail ' + String((e && e.message) || e).slice(0, 120));
    }
  }

  if (!tried) return { ok: false, detail: 'no_channel' };
  return { ok: false, detail: errors.join(' | ').slice(0, 280) };
}

/* ---------------- 心跳 ---------------- */

/** 记一条运行痕迹：worker 是静默定时任务，没有心跳就等于「看不见的管道」。
    密钥不对时这个调用也会被拒 —— 那正是「后台显示没有运行记录」的正确信号。 */
async function beat(secret, status, sent, failed, detail) {
  try {
    return await pg.rpc('notify_worker_beat', {
      p_secret: secret,
      p_status: status,
      p_sent: sent || 0,
      p_failed: failed || 0,
      p_detail: detail ? String(detail).slice(0, 300) : null
    });
  } catch (e) {
    return null;
  }
}

/* ---------------- 入口 ---------------- */

exports.main = async function (event) {
  const action = event && event.action ? event.action : 'drain';
  const secret = str(process.env.NOTIFY_WORKER_SECRET).trim();

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
      message: '缺少 NOTIFY_WORKER_SECRET：请把后台「通知」面板里的投递密钥填进本函数的环境变量。'
    };
  }

  /* 1. 先读投递配置 —— 没有渠道就不领取，避免白烧队列的尝试次数 */
  let cfgRes;
  try {
    cfgRes = await pg.rpc('notify_worker_config', { p_secret: secret });
  } catch (e) {
    return { ok: false, code: 'CONFIG_FAILED', message: String((e && e.message) || e) };
  }
  if (!cfgRes || cfgRes.ok !== true) {
    return {
      ok: false,
      code: 'SECRET_REJECTED',
      message: '共享密钥不被接受：函数里的 NOTIFY_WORKER_SECRET 与后台「通知」面板里的投递密钥不一致。'
    };
  }

  const cfg = normalizeConfig(cfgRes.config);
  const probe = {
    endpoint: pg.endpoint,
    webhookConfigured: cfg.webhookUrl !== '',
    webhookKind: cfg.webhookKind,
    mailEnabled: cfg.mailEnabled,
    mailConfigured: mailReady(cfg),
    mailerInstalled: !!getMailer()
  };

  if (action === 'probe') {
    await beat(secret, 'probe', 0, 0, null);
    return { ok: true, action: 'probe', config: probe };
  }

  if (!cfg.webhookUrl && !mailReady(cfg)) {
    await beat(secret, 'skipped_no_channel', 0, 0, '未配置 Webhook 地址或邮件通道');
    return { ok: true, action: 'drain', skipped: 'no_channel', config: probe };
  }

  /* 2. 领取并投递 */
  let claimed;
  try {
    claimed = await pg.rpc('notify_outbox_claim', { p_secret: secret, p_limit: DEFAULT_LIMIT });
  } catch (e) {
    await beat(secret, 'claim_error', 0, 0, e && e.message);
    return { ok: false, code: 'CLAIM_FAILED', message: String((e && e.message) || e) };
  }
  if (!claimed || claimed.ok !== true) {
    await beat(secret, 'claim_rejected', 0, 0, null);
    return { ok: false, code: 'CLAIM_REJECTED', message: '领取被拒（密钥在两次调用之间被轮换？）' };
  }

  const rows = claimed.rows || [];
  if (!rows.length) {
    await beat(secret, 'idle', 0, 0, null);
    return { ok: true, action: 'drain', claimed: 0, config: probe };
  }

  let sent = 0, failed = 0;
  const failures = [];
  for (const row of rows) {
    const res = await deliver(row, cfg, secret);
    if (res.ok) sent++; else { failed++; failures.push(row.id + ':' + res.detail); }
    try {
      await pg.rpc('notify_outbox_ack', res.ok
        ? { p_secret: secret, p_id: row.id, p_ok: true }
        : { p_secret: secret, p_id: row.id, p_ok: false, p_error: res.detail });
    } catch (e) {
      failures.push(row.id + ':ack ' + String((e && e.message) || e).slice(0, 60));
    }
  }

  await beat(secret, failed ? 'partial' : 'ok', sent, failed, failures.slice(0, 3).join(' | '));

  return {
    ok: true,
    action: 'drain',
    claimed: rows.length,
    sent: sent,
    failed: failed,
    failures: failures.slice(0, 5),
    config: probe
  };
};
