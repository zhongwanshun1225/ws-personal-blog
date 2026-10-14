// cloudfunctions/ws-notify/pgrest.js
// 访问本站云数据库的最小 REST 客户端（服务端专用）。
//
// 走的是站点自己在用的那条通道：
//   POST https://<站点域名>/.cloud/database/rest/rpc/<函数名>
//   header: x-wb-webapp-access-key: <发布密钥>
//
// 为什么不用 CloudBase 的 PG 网关（<envId>.api.tcloudbasegateway.com）：
// 本环境的网关只给「通过数据模型工具创建」的表建了 schema 缓存，
// ws-blog 的表全部返回 PGRST205（表不在 schema cache 里），走不通。
// 而站点通道对**不带 Origin 的服务端调用**放行，正好是 worker 的场景。
//
// 安全边界不靠这条通道，而是靠 notify_outbox_claim / ack 里的共享密钥：
// 发布密钥本来就是公开的（前端里就有），拿不到 worker_secret 就调不动队列。

const https = require('https');

const ENDPOINT = (process.env.WS_BLOG_ENDPOINT || 'https://ws-blog.app.workbuddy.host').replace(/\/+$/, '');
const ACCESS_KEY = process.env.WS_BLOG_ACCESS_KEY || '';

function configured() {
  return !!(ENDPOINT && ACCESS_KEY);
}

function post(path, body, timeout) {
  return new Promise(function (resolve, reject) {
    if (!configured()) {
      reject(new Error('CLOUD_NOT_CONFIGURED'));
      return;
    }
    const payload = JSON.stringify(body === undefined ? {} : body);
    let target;
    try {
      target = new URL(ENDPOINT);
    } catch (e) {
      reject(new Error('BAD_ENDPOINT'));
      return;
    }
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-wb-webapp-access-key': ACCESS_KEY
      },
      timeout: timeout || 10000
    }, function (res) {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        let json = null;
        try { json = b ? JSON.parse(b) : null; } catch (e) { json = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(json);
          return;
        }
        const err = new Error('CLOUD_HTTP_' + res.statusCode + ': ' +
          ((json && (json.message || json.error_description || json.error)) ||
            String(b).slice(0, 200)));
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { this.destroy(new Error('CLOUD_TIMEOUT')); });
    req.write(payload);
    req.end();
  });
}

/** 调一个存储过程（SECURITY DEFINER，权限由函数内部判定） */
function rpc(name, args) {
  return post('/.cloud/database/rest/rpc/' + name, args || {});
}

module.exports = {
  configured: configured,
  rpc: rpc,
  endpoint: ENDPOINT
};
