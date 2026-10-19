/* 第六批静态冒烟（缺口 M2–M16）：断言新控件进了产物、脚本能力到位、
 * 脚本里用到的 i18n 键都在字典里，并用无头 Chrome 扫一遍 console。
 *
 * 为什么不做登录态 E2E：云端按 Origin 校验，只放行 https://ws-blog.app.workbuddy.host，
 * 本地 127.0.0.1 上所有云端调用（登录 / 评论 / 举报 / 后台）都会被拒绝 ——
 * 所以「点顶踩 / 提交改邮箱申请 / 处理举报」这些只能在线上手测。
 * 这里保证「模板漏元素 / 脚本没加载 / 文案键写错 / JS 语法炸了」这类本地能抓的问题不溜过去。
 *
 * 用法：node tests/batch6-smoke.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4208;
const ROOT = path.resolve(import.meta.dirname, '..', 'dist');
import { probeChrome, resolveChrome, filterPageErrors } from './_serve.mjs';
/* Chrome 路径解析 + 真·可用性探测（见 _serve.mjs）：探测不过就置空 ——
 * 依赖 DOM 的断言整段跳过，静态断言照跑。 */
const CHROME = await probeChrome(resolveChrome());
if (!CHROME) console.log('  SKIP 浏览器不可用（设 CHROME_BIN 可指定）— 只跑静态断言');
const PROFILE = path.resolve(import.meta.dirname, '.chrome-batch6-smoke');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, url);
  if (url.endsWith('/')) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;

function fetchText(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function runChrome(url) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--user-data-dir=${PROFILE}-${Math.random().toString(36).slice(2, 8)}`,
      '--virtual-time-budget=5000', '--dump-dom',
      '--enable-logging=stderr', '--log-level=0', url,
    ];
    const p = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve({ out, err }));
    p.on('error', (e) => resolve({ out: '', err: String(e) }));
  });
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const cache = new Map();
async function text(p) {
  if (!cache.has(p)) cache.set(p, await fetchText(p));
  return cache.get(p);
}

/* ---------------- 1. 新增脚本进产物 ---------------- */
console.log('— 新增脚本 —');
{
  const crop = await text('/assets/avatar-crop.js');
  check('avatar-crop.js → 200', crop.status === 200, `got ${crop.status}`);
  for (const [label, needle] of [
    ['暴露 WSBlogAvatar', 'window.WSBlogAvatar'],
    ['导出 JPEG 压缩', "'image/jpeg'"],
    ['拖动平移（Pointer Events）', 'pointermove'],
    ['把偏移夹在画布内', 'Math.max(size - w, '],
  ]) check(label, crop.body.includes(needle));

  const onboard = await text('/assets/onboard.js');
  check('onboard.js → 200', onboard.status === 200, `got ${onboard.status}`);
  for (const [label, needle] of [
    ['暴露 WSBlogOnboard', 'window.WSBlogOnboard'],
    ['个人中心只做高亮', 'data-onboard-target'],
    ['其他页面弹卡片', 'data-onboard'],
    ['本机记住「以后再说」', 'wsblog:onboard:v1'],
  ]) check(label, onboard.body.includes(needle));

  const sw = (await text('/sw.js')).body;
  check('SW 预缓存 onboard.js', sw.includes("assets/onboard.js"));
  /* 断言版本号呈 `wsblog-vN` 且 N ≥ 已知地板，而不是钉死某个具体版本 ——
   * 钉死的话每次正常升版都会假失败（本次即如此），失去回归价值。 */
  check('SW 版本已提升（旧缓存会清）', /var VERSION = 'wsblog-v(\d+)'/.test(sw) && Number(RegExp.$1) >= 3);
}

/* ---------------- 2. 个人中心模板 ---------------- */
console.log('— 个人中心模板（M5 / M6 / M7 / M9 / M10 / M11 / M12 / M13） —');
{
  const { status, body } = await text('/account.html');
  check('account.html → 200', status === 200, `got ${status}`);
  for (const [label, needle] of [
    ['邮箱验证按钮', 'data-email-verify'],
    ['邮箱验证码输入', 'data-email-code'],
    ['发验证码按钮', 'data-email-code-send'],
    ['提交验证码', 'data-email-code-submit'],
    ['改邮箱 · 新邮箱', 'data-email-new'],
    ['改邮箱 · 当前密码自证', 'data-email-password'],
    ['改邮箱 · 说明', 'data-email-change-note'],
    ['改邮箱 · 提交', 'data-email-change-submit'],
    ['登录设备列表', 'data-session-list'],
    ['退出其他设备', 'data-session-kill'],
    ['收藏分组条', 'data-folder-bar'],
    ['最近阅读', 'data-my-reading'],
    ['黑名单', 'data-my-blocks'],
    ['导出数据', 'data-export-data'],
    ['注销账号', 'data-delete-account'],
    ['注销二次确认输入', 'data-delete-confirm'],
    ['头像裁剪弹窗', 'data-avatar-modal'],
    ['裁剪画布', 'data-crop-canvas'],
    ['缩放滑块', 'data-crop-zoom'],
    ['应用裁剪', 'data-crop-apply'],
    ['引用裁剪脚本', 'assets/avatar-crop.js'],
    ['邮箱状态徽标', 'data-email-status'],
  ]) check(label, body.includes(needle));
  check('裁剪画布是 256×256',
    body.includes('width="256"') && body.includes('height="256"'));
}

/* ---------------- 3. 文章页评论区 ---------------- */
console.log('— 文章页评论区（M2 / M3 / M4 / M16） —');
{
  const { body } = await text('/posts/400-lines-static-site-generator.html');
  for (const [label, needle] of [
    ['加载 interact.js（此前漏挂）', 'assets/interact.js'],
    ['格式工具条', 'data-comment-format'],
    ['表情按钮', 'data-emoji-toggle'],
    ['代码块按钮', 'data-code-insert'],
    ['表情面板', 'data-emoji-picker'],
    ['@提及提示', 'mentionHint'],
  ]) check(label, body.includes(needle));
  check('interact 容器只有一份（无重复实现）',
    body.split('data-interact').length - 1 === 1,
    `count=${body.split('data-interact').length - 1}`);
  check('评论框说明支持代码块', body.includes('代码块'));
}

/* ---------------- 4. 登录页 ---------------- */
console.log('— 登录页（M8 / M14） —');
{
  const { body } = await text('/login.html');
  for (const [label, needle] of [
    ['失败锁定提示位', 'data-auth-lock'],
    ['第三方登录区块', 'data-oauth'],
    ['第三方按钮容器', 'data-oauth-buttons'],
    ['分隔线文案', 'auth.oauthOr'],
  ]) check(label, body.includes(needle));
  check('第三方区块默认隐藏（无 relay 时不露空壳）',
    /data-oauth hidden|hidden[^>]*data-oauth/.test(body) || body.includes('data-oauth hidden'));
}

/* ---------------- 5. 后台新增分区 ---------------- */
console.log('— 后台「举报与申请」分区（M13 / M5） —');
{
  const { body } = await text('/admin.html');
  for (const [label, needle] of [
    ['标签页', 'data-admin-tab="reports"'],
    ['标签页角标', 'data-reports-badge'],
    ['面板容器', 'data-admin-panel="reports"'],
    ['举报列表', 'data-admin-reports'],
    ['待处理数', 'data-report-open'],
    ['举报筛选', 'data-report-filter="open"'],
    ['举报分页', 'data-report-pager'],
    ['邮箱申请列表', 'data-admin-email-requests'],
    ['邮箱申请计数', 'data-email-request-count'],
    ['概览卡·待处理举报', 'data-stat-open-reports'],
    ['概览卡·邮箱变更申请', 'data-stat-email-requests'],
    ['用户表·邮箱状态列', '<th>邮箱状态</th>'],
    ['用户筛选·已注销', 'value="deleted"'],
    ['用户筛选·有待处理邮箱申请', 'value="email"'],
  ]) check(label, body.includes(needle));
}

/* ---------------- 6. 样式 ---------------- */
console.log('— 样式（第六批新增组件） —');
{
  const css = (await text('/assets/main.css')).body;
  for (const [label, needle] of [
    ['评论代码块', '.comment__code'],
    ['行内代码', '.comment__inline'],
    ['@提及高亮', '.comment__mention'],
    ['顶踩按钮', '.comment__vote'],
    ['已编辑标记', '.comment__edited'],
    ['表情面板', '.emoji-picker'],
    ['拉黑折叠条', '.comment-blocked-note'],
    ['继续阅读浮条', '.resume-bar'],
    ['阅读进度条', '.progress__bar'],
    ['通用弹窗', '.modal__panel'],
    ['弹窗锁滚动', 'body.is-modal-open'],
    ['裁剪台', '.crop-canvas'],
    ['登录锁定提示', '.auth-lock'],
    ['第三方登录分隔线', '.auth-oauth__sep'],
    ['引导卡', '.onboard-card'],
    ['面板内高亮块', '.onboard-inline'],
    ['数据操作卡', '.data-action'],
    ['邮箱变更折叠块', '.account-details'],
    ['虚线分组按钮', '.chip--dashed'],
    ['小号输入框', '.field__input--sm'],
    ['已验证徽标', '.badge--ok'],
    ['危险面板', '.panel--danger'],
    ['提及类通知配色', '.notif__kind--mention'],
  ]) check(label, css.includes(needle));
}

/* ---------------- 7. 脚本能力 ---------------- */
console.log('— 浏览器端脚本能力 —');
{
  const cases = [
    ['/assets/interact.js', [
      ['15 分钟编辑窗口', 'EDIT_WINDOW_MS'],
      ['顶踩 RPC', 'comment_vote'],
      ['编辑落到 comments 表', ".from('comments')"],
      ['举报写入 comment_reports', 'comment_reports'],
      ['拉黑写入 user_blocks', 'user_blocks'],
      ['阅读进度写入 reading_history', 'reading_history'],
      ['代码块渲染', 'FENCE_RE'],
      ['提及渲染', 'MENTION_RE'],
      ['对外复用评论渲染', 'renderBody: renderCommentBody'],
      ['服务端拒绝编辑窗口时给专门文案', 'EDIT_WINDOW_CLOSED'],
    ]],
    ['/assets/account.js', [
      ['改邮箱申请 RPC', 'request_email_change'],
      ['邮箱归属标记 RPC', 'mark_email_verified'],
      ['设备登记 RPC', 'session_touch'],
      ['退出其他设备 RPC', 'session_kill_others'],
      ['导出数据 RPC', 'export_my_data'],
      ['注销账号 RPC', 'delete_my_account'],
      ['收藏私密字段', 'is_private'],
      ['收藏分组字段', 'folder'],
      ['调用头像裁剪', 'WSBlogAvatar'],
      ['复用评论渲染', 'WSBlogInteract'],
      ['密码自证后再申请', 'signInWithPassword'],
      ['登录设备说明是软踢出视野内的操作', 'sessionKillConfirm'],
    ]],
    ['/assets/auth.js', [
      ['第三方登录', 'signInWithOAuth'],
      ['回调换取会话', 'handleOAuthCallback'],
      ['回调用 provider_id 判定', "provider_id"],
      ['provider 只列可用项', "'wechat'"],
      ['本机失败计数', 'wsblog:auth-lock:v1'],
      ['阈值 5 次', 'MAX_FAILS = 5'],
      ['锁 5 分钟', 'LOCK_MS = 5 * 60 * 1000'],
      ['断网不计入失败', 'isAuthFailure'],
    ]],
    ['/assets/admin.js', [
      ['举报分页 RPC', 'admin_reports_page'],
      ['举报处理 RPC', 'admin_resolve_report'],
      ['邮箱申请处理 RPC', 'admin_resolve_email_change'],
      ['邮箱申请复用用户分页口径', "p_status: 'email'"],
      ['邮箱状态列渲染', 'email_verified_at'],
      ['待处理申请展示', 'pending_email'],
      ['举报角标', 'setReportsBadge'],
    ]],
    ['/assets/cloud.js', [
      ['设备登记（全站生效）', 'session_touch'],
      ['设备指纹字段', 'p_ua'],
      ['软踢出后自动登出', 'revoked'],
      ['设备名推断', 'deviceLabel'],
      ['暴露会话 key', 'sessionKey: localSessionKey'],
    ]],
    ['/assets/notifications.js', [
      ['提及类通知', 'mention'],
      ['邮箱申请通知', 'email_request'],
      ['邮箱已变更通知', 'email_changed'],
      ['举报已处理通知', 'report_resolved'],
    ]],
  ];
  for (const [file, items] of cases) {
    const js = (await text(file)).body;
    for (const [label, needle] of items) check(`${file.replace('/assets/', '')} · ${label}`, js.includes(needle));
  }
}

/* ---------------- 8. i18n 键完整性 ---------------- */
console.log('— i18n：脚本用到的键必须都在字典里 —');
{
  const i18n = (await text('/assets/i18n.js')).body;
  const dict = new Set();
  for (const m of i18n.matchAll(/"([a-zA-Z]+\.[A-Za-z0-9]+)"\s*:/g)) dict.add(m[1]);
  check('字典非空', dict.size > 300, `size=${dict.size}`);

  const scripts = ['interact.js', 'account.js', 'auth.js', 'onboard.js', 'avatar-crop.js', 'admin.js', 'notifications.js'];
  const missing = new Set();
  for (const name of scripts) {
    const js = (await text('/assets/' + name)).body;
    for (const m of js.matchAll(/\b(?:t|fill)\(\s*'([a-zA-Z]+\.[A-Za-z0-9]+)'/g)) {
      if (!dict.has(m[1])) missing.add(`${name}:${m[1]}`);
    }
  }
  check('没有写错的文案键', missing.size === 0, [...missing].slice(0, 6).join(', '));
}

/* ---------------- 9. HTTP 可达性 ---------------- */
console.log('— HTTP 资源 —');
for (const p of ['/', '/login.html', '/account.html', '/admin.html', '/notifications.html',
                 '/write.html', '/subscribe.html', '/archive.html', '/shortcuts.html',
                 '/assets/avatar-crop.js', '/assets/onboard.js', '/assets/interact.js',
                 '/assets/account.js', '/assets/auth.js', '/assets/admin.js', '/sw.js']) {
  const r = await text(p);
  check(`${p} → 200`, r.status === 200, `got ${r.status}`);
}

/* ---------------- 10. 无头 Chrome ---------------- */
console.log('— 无头 Chrome：console / 未捕获异常 —');
if (!CHROME) {
  console.log('  SKIP 未找到 Chrome（设 CHROME_BIN 可指定）— 静态断言已覆盖模板/脚本层面');
} else for (const page of ['/', '/login.html', '/account.html', '/admin.html', '/notifications.html',
                    '/posts/400-lines-static-site-generator.html']) {
  const { out, err } = await runChrome(BASE + page);
  // 过滤规则见 _serve.mjs::filterPageErrors —— 关键是剔掉 Chrome 自身进程日志
  // （CI/Linux 上的 dbus / GPU / sandbox 噪音），只留页面 JS 真正抛的错。
  const noise = filterPageErrors(err);
  check(`${page} 无未捕获异常`, noise.trim() === '', noise.slice(0, 300));
  check(`${page} 有内容`, out.includes('<body'));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
