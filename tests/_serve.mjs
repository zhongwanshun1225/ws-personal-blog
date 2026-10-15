/**
 * 探针共用：起一个只读 dist/ 的静态服务，供需要 HTTP 抓产品/无头 Chrome 的脚本使用。
 *
 * 为什么要有它：以前 `tests/*-smoke.mjs` 假定外部已有 `python build.py --serve --port 4199`
 * 在跑，CI 里没有这一步，脚本会 ECONNREFUSED。现在每个脚本自带服务，自给自足。
 *
 * 用法：
 *   import { startStaticServer, resolveChrome } from './_serve.mjs';
 *   const { server, base, close } = await startStaticServer(4199);
 *   ...
 *   await close();
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.resolve(HERE, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function startStaticServer(port = 4199, root = DIST) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(root, url);
    if (url.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Chrome 路径：本地 Windows 固定路径优先，其次常见 Linux/macOS 位置；
 * 都找不到返回空串 —— 调用方据此整段跳过 DOM 断言（CI 上不算失败）。
 */
export function resolveChrome() {
  const cands = [
    process.env.CHROME_BIN,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return '';
}

/**
 * 真·可用性探测：路径存在 ≠ 能跑。
 * 本沙箱就是典型反例 —— chrome.exe 在，但任何调用都不产出字节（连 --version 都是空）。
 * 做法：跑一次 `--headless=new --dump-dom` 抓一个 data: URL，拿不到含 `<body` 的输出就当不可用，
 * 返回空串让调用方跳过 DOM 断言。**有超时兜底**，避免卡死 CI。
 */
export function probeChrome(bin, { timeoutMs = 25000 } = {}) {
  if (!bin) return Promise.resolve('');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try {
      p = spawn(bin, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
        `--user-data-dir=${path.join(HERE, '.chrome-probe-' + Math.random().toString(36).slice(2, 8))}`,
        '--virtual-time-budget=3000', '--dump-dom', 'data:text/html,<body>ok</body>',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return resolve(''); }
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => finish(''));
    p.on('close', () => finish(out.includes('<body') ? bin : ''));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } finish(''); }, timeoutMs);
  });
}
