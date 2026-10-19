/* 第四批静态冒烟：断言模板里的新控件真的进了产物，并用无头 Chrome 扫一遍 console。
 *
 * 为什么不做登录态 E2E：云端按 Origin 校验，只放行 https://ws-blog.app.workbuddy.host，
 * 本地 127.0.0.1 上所有云端调用（登录/评论/后台）都会被 403 —— 所以后台那套
 * 「点通过 / 点驳回」只能在线上手测，这里保证「模板漏元素 / 脚本报错」这类
 * 本地能抓到的问题不溜过去。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { probeChrome, resolveChrome, filterPageErrors } from './_serve.mjs';

const PORT = 4207;
const ROOT = path.resolve(import.meta.dirname, '..', 'dist');
/* Chrome 路径解析 + 真·可用性探测（见 _serve.mjs）：探测不过就置空 ——
 * 依赖 DOM 的断言整段跳过，静态断言照跑，不把环境问题误报成回归。 */
const CHROME = await probeChrome(resolveChrome());
if (!CHROME) console.log('  SKIP 浏览器不可用（设 CHROME_BIN 可指定）— 只跑静态断言');
const PROFILE = path.resolve(import.meta.dirname, '.chrome-batch4-smoke');

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

console.log('— 模板产物：后台新增控件 —');
{
  const { status, body } = await fetchText('/admin.html');
  check('admin.html → 200', status === 200, `got ${status}`);
  for (const [label, needle] of [
    ['统计卡·待审评论', 'data-stat-pending-comments'],
    ['统计卡·待审改稿', 'data-stat-edit-pending'],
    ['待审改稿面板', 'data-admin-edits'],
    ['待审改稿计数', 'data-edit-count'],
    ['待审改稿分页', 'data-edit-pager'],
    ['评论筛选·待审档', 'data-comment-filter="pending"'],
    ['评论筛选·显示中', 'data-comment-filter="visible"'],
    ['敏感词输入框', 'data-word-input'],
    ['敏感词添加按钮', 'data-word-add'],
    ['敏感词列表容器', 'data-word-list'],
    ['用户表·改稿权限列', '改稿权限'],
    ['评论状态列', '<th>状态</th>'],
  ]) check(label, body.includes(needle));

  check('「下架才能改」的旧说法已消失',
    !body.includes('已发布的文章不能在这里修改'));
}

console.log('— 模板产物：个人中心安全设置 —');
{
  const { body } = await fetchText('/account.html');
  for (const [label, needle] of [
    ['安全设置面板', '账号安全'],
    ['当前密码', 'data-password-old'],
    ['新密码', 'data-password-new'],
    ['确认新密码', 'data-password-confirm'],
    ['保存按钮', 'data-password-save'],
    ['指向忘记密码', 'login.html'],
    ['我的投稿容器', 'data-my-posts'],
  ]) check(label, body.includes(needle));
}

console.log('— 模板产物：投稿页 —');
{
  const { body } = await fetchText('/write.html');
  check('投稿页有我的投稿列表', body.includes('data-my-posts'));
  check('投稿须知写明可自改', body.includes('可以自己改'));
  check('投稿须知区分「直接生效 / 进待审」',
    body.includes('受信任作者改完立即生效') && body.includes('进入待审'));
}

console.log('— 模板产物：评论区文案 —');
{
  const { body } = await fetchText('/posts/400-lines-static-site-generator.html');
  check('评论框提示需审核', body.includes('提交后需站长审核才公开'));
  check('评论框不再暗示立即显示', !body.includes('提交后立即显示'));
}

console.log('— 浏览器端脚本含新能力（产物级）—');
{
  const adminJs = (await fetchText('/assets/admin.js')).body;
  const writeJs = (await fetchText('/assets/write.js')).body;
  const accountJs = (await fetchText('/assets/account.js')).body;
  for (const [label, needle] of [
    ['admin 改稿对照（看改动）', 'data-edit-view'],
    ['admin 改稿分页', 'data-edit-pager'],
    ['admin 授权直接改稿', 'admin_set_can_publish'],
    ['admin 改稿审核 RPC', 'admin_review_edit'],
    ['admin 改稿对照 RPC', 'admin_post_edit_detail'],
    ['admin 敏感词增删', 'admin_add_comment_word'],
    ['admin 用户开关用 data-user-toggle（不与筛选下拉撞名）', 'data-user-toggle'],
    ['admin 不再误绑筛选下拉', "qa('[data-user-status]')"],
  ]) {
    const ok = label.includes('不再误绑') ? !adminJs.includes(needle) : adminJs.includes(needle);
    check(label, ok);
  }
  for (const [label, needle] of [
    ['write 走改稿 RPC', 'author_update_post'],
    ['write 有「提交修改」', '提交修改'],
    ['write 区分 direct / pending', "'direct'"],
    ['write 载入 edit_* 影子副本', 'edit_content_md'],
  ]) check(label, writeJs.includes(needle));
  for (const [label, needle] of [
    ['account 显示修改待审', '修改待审'],
    ['account 已发布也有修改入口', '查看修改'],
  ]) check(label, accountJs.includes(needle));

  const cloudJs = (await fetchText('/assets/cloud-posts.js')).body;
  for (const [label, needle] of [
    ['云文章详情有署名额', 'data-cloud-author'],
    ['署名取 profiles_public', 'profiles_public'],
    ['署名链接到作者主页', "authors/'"],
  ]) check(label, cloudJs.includes(needle));
}

console.log('— HTTP 资源 —');
for (const p of ['/', '/write.html', '/account.html', '/admin.html', '/login.html',
                 '/assets/write.js', '/assets/account.js', '/assets/admin.js',
                 '/assets/draft.js', '/assets/notify.js', '/assets/notifications.js']) {
  const r = await fetchText(p);
  check(`${p} → 200`, r.status === 200, `got ${r.status}`);
}

console.log('— 无头 Chrome：console / 未捕获异常 —');
if (!CHROME) {
  console.log('  SKIP 未找到 Chrome（设 CHROME_BIN 可指定）— 静态断言已覆盖模板/脚本层面');
} else for (const page of ['/', '/write.html', '/account.html', '/admin.html']) {
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
