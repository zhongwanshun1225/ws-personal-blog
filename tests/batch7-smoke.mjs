/* 第七批静态冒烟（A3–A5 + B2–B17）：
 * 断言新控件进了产物、脚本能力到位、i18n 键都在字典里，
 * 并用无头 Chrome 扫一遍 console（抓「语法炸了 / 元素没找到」这类问题）。
 *
 * 为什么不做登录态 E2E：云端按 Origin 校验，只放行 https://ws-blog.app.workbuddy.host，
 * 本地 127.0.0.1 上所有云端调用（登录 / 后台 / 投稿）都会被拒 403 ——
 * 所以「批量删除 / 生成预览链接 / 开启 2FA」这些只能在线上手测。
 *
 * 用法：node tests/batch7-smoke.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4217;
const ROOT = path.resolve(import.meta.dirname, '..', 'dist');
import { probeChrome, resolveChrome } from './_serve.mjs';
/* Chrome 路径解析 + 真·可用性探测（见 _serve.mjs）：探测不过就置空 ——
 * 依赖 DOM 的断言整段跳过，静态断言照跑。 */
const CHROME = await probeChrome(resolveChrome());
if (!CHROME) console.log('  SKIP 浏览器不可用（设 CHROME_BIN 可指定）— 只跑静态断言');
const PROFILE = path.resolve(import.meta.dirname, '.chrome-batch7-smoke');

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

function runChrome(url, budget = 4000) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--user-data-dir=${PROFILE}-${Math.random().toString(36).slice(2, 8)}`,
      `--virtual-time-budget=${budget}`, '--dump-dom',
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

const absent = (body, needle) => !body.includes(needle);

/* ---------------- 1. 新脚本进产物 ---------------- */
console.log('— 新增脚本 —');
{
  for (const name of ['banner.js', 'chart.js', 'preview.js', 'write-ext.js', 'admin-ext.js']) {
    const res = await text('/assets/' + name);
    check(`${name} → 200`, res.status === 200, `got ${res.status}`);
  }

  const banner = (await text('/assets/banner.js')).body;
  for (const [label, needle] of [
    ['暴露 settings_public', 'settings_public'],
    ['按内容指纹记忆关闭', 'wsblog:announce'],
    ['维护模式可用 ?maintenance=off 绕过', 'maintenance=off'],
    ['绕过时向服务端确认身份', 'my_admin_role'],
    ['跟随界面语言切换', 'wsblog:langchange'],
  ]) check('banner.js · ' + label, banner.includes(needle));

  const chart = (await text('/assets/chart.js')).body;
  for (const [label, needle] of [
    ['暴露 WSBlogChart', 'window.WSBlogChart'],
    ['折线图', 'function line('],
    ['条形图', 'function bars('],
    ['迷你走势', 'function sparkline('],
    ['体积格式化', 'function humanBytes('],
  ]) check('chart.js · ' + label, chart.includes(needle));

  const preview = (await text('/assets/preview.js')).body;
  for (const [label, needle] of [
    ['调 post_preview_get', 'post_preview_get'],
    ['支持 ?token=', "token"],
    ['渲染 Markdown', 'WSBlogCloudMarkdown'],
  ]) check('preview.js · ' + label, preview.includes(needle));

  const wext = (await text('/assets/write-ext.js')).body;
  for (const [label, needle] of [
    ['A4 生成预览', 'post_preview_create'],
    ['A4 撤销预览', 'post_preview_revoke'],
    ['A5 修订列表', 'post_revisions_list'],
    ['A5 读某一版', 'post_revisions_get'],
    ['A5 回滚', 'post_revision_restore'],
    ['监听编辑器状态', 'wsblog:editor'],
  ]) check('write-ext.js · ' + label, wext.includes(needle));

  const aext = (await text('/assets/admin-ext.js')).body;
  for (const [label, needle] of [
    ['B2 批量', 'admin_bulk'],
    ['B3 投递队列', 'admin_outbox_page'],
    ['B3 重试', 'admin_outbox_retry'],
    ['B5 导出', 'admin_export'],
    ['B5 备份登记', 'admin_backup_record'],
    ['B5 备份列表', 'admin_backups_page'],
    ['B6 设置读', 'admin_settings_get'],
    ['B6 设置写', 'admin_settings_set'],
    ['B7 媒体分页', 'media_page'],
    ['B7 媒体登记', 'media_register'],
    ['B7 媒体删除', 'media_delete'],
    ['B8 排序定时', 'admin_set_post_flags'],
    ['B9 趋势', 'admin_stats_trend'],
    ['B9 热门', 'admin_top_posts'],
    ['B10 访问分析', 'admin_analytics'],
    ['B11 角色分档（经 cloud.myRole 判定）', 'C.myRole('],
    ['B11 角色拦截面板', 'ADMIN_ONLY_PANELS'],
    ['B13 2FA 状态', 'totp_status'],
    ['B13 2FA 绑定', 'totp_begin'],
    ['B13 2FA 开启', 'totp_enable'],
    ['B13 2FA 关闭', 'totp_disable'],
    ['B14 健康检查', 'admin_health'],
    ['B15 公告/维护开关（对象内字段写回）', "el.getAttribute('data-set-flag')"],
    ['B3 worker 状态渲染', 'renderWorkerState'],
    ['B16 模板键', 'mail.tpl.comment'],
    ['B17 垃圾队列', 'admin_spam_page'],
    ['对外接口 onList', 'onList: onList'],
    ['对外接口 refresh', 'refresh: refresh'],
    ['面板懒加载表', 'var LOADERS'],
  ]) check('admin-ext.js · ' + label, aext.includes(needle));

  const admin = (await text('/assets/admin.js')).body;
  for (const [label, needle] of [
    ['勾选格', 'function pickCell('],
    ['排序/定时列', 'function flagsCell('],
    ['风险分列', 'function riskCell('],
    ['编辑角色按钮', 'data-user-editor'],
    ['2FA 重置按钮', 'data-user-totp-off'],
    ['非垃圾按钮', 'data-comment-ham'],
    ['排序弹窗入口', 'data-post-flags'],
    ['B12 审计分页', 'admin_audit_page'],
    ['B12 动作清单', 'admin_audit_actions'],
    ['B12 CSV 导出', 'exportAuditCsv'],
    ['编辑器按需展开', 'function openEditor('],
    ['编辑器状态广播', 'broadcastEditor'],
    ['定时字段', 'data-admin-schedule'],
    ['scheduled 状态', "scheduled: { label:"],
    ['扩展钩子', 'WSBlogAdminExt'],
    ['扩展刷新并入统一刷新', 'extRefresh()'],
  ]) check('admin.js · ' + label, admin.includes(needle));

  const cloud = (await text('/assets/cloud.js')).body;
  for (const [label, needle] of [
    ['后台角色读取', 'loadStaffRole'],
    ['角色导出 myRole', 'myRole: function'],
    ['编辑放行守卫', "staffRole === 'editor'"],
  ]) check('cloud.js · ' + label, cloud.includes(needle));

  const sw = (await text('/sw.js')).body;
  check('SW 预缓存 banner.js', sw.includes("assets/banner.js"));
  check('SW 预缓存 analytics.js', sw.includes("assets/analytics.js"));
  /* 同 batch6：只要求 `wsblog-vN` 且 N ≥ 地板，不钉死具体版本。 */
  check('SW 版本已提升（旧缓存会清）', /var VERSION = 'wsblog-v(\d+)'/.test(sw) && Number(RegExp.$1) >= 5);

  /* B10 的上报端：只有面板没有埋点的话，后台统计永远是空的 */
  const an = (await text('/assets/analytics.js')).body;
  for (const [label, needle] of [
    ['调用 page_view_log', 'page_view_log'],
    ['上报路径', 'p_path'],
    ['上报来源', 'p_referrer'],
    ['上报 UA', 'p_ua'],
    ['上报会话指纹', 'p_session'],
    ['私有页面不埋点', "'admin.html'"],
    ['尊重 DNT', 'doNotTrack'],
    ['提供退出开关', 'wsblog:analytics'],
    ['会话指纹按天轮换', 'toISOString().slice(0, 10)'],
  ]) check('analytics.js · ' + label, an.includes(needle));
}

/* ---------------- 2. 投稿页（A3 / A4 / A5） ---------------- */
console.log('— 投稿页 write.html（A3 / A4 / A5） —');
{
  const { status, body } = await text('/write.html');
  check('write.html → 200', status === 200, `got ${status}`);
  for (const [label, needle] of [
    ['期望发布时间字段', 'data-write-schedule'],
    ['定时说明文案', '到点自动上线'],
    ['预览链接面板', 'data-preview-panel'],
    ['预览有效期选择', 'data-preview-days'],
    ['生成预览按钮', 'data-preview-create'],
    ['预览列表', 'data-preview-list'],
    ['修订历史面板', 'data-revisions-panel'],
    ['修订列表', 'data-revision-list'],
    ['修订查看区', 'data-revision-view'],
    ['回滚按钮', 'data-revision-restore'],
    ['引用 write-ext.js', 'assets/write-ext.js'],
  ]) check(label, body.includes(needle));
  /* 投稿页不该拉预览页专用脚本，免得白下一个文件 */
  check('投稿页未引用 preview.js', absent(body, 'assets/preview.js'));
}

/* ---------------- 3. 预览分享页（A4） ---------------- */
console.log('— 预览页 preview.html（A4） —');
{
  const { status, body } = await text('/preview.html');
  check('preview.html → 200', status === 200, `got ${status}`);
  for (const [label, needle] of [
    ['预览页根节点', 'data-preview'],
    ['预览提示条', 'preview-banner'],
    ['内容容器', 'data-preview-body'],
    ['错误态', 'data-preview-error'],
    ['引用 preview.js', 'assets/preview.js'],
    ['带 robots noindex（不该被搜索引擎收录）', 'noindex'],
  ]) check(label, body.includes(needle));
}

/* ---------------- 4. 公告条 / 维护模式（B15） ---------------- */
console.log('— 公告与维护（B15） —');
{
  const { body } = await text('/index.html');
  check('全站注入公告条容器', body.includes('data-announce'));
  check('全站注入维护遮罩', body.includes('data-maintenance'));
  check('全站加载 banner.js', body.includes('assets/banner.js'));
  check('全站加载 analytics.js（B10 上报端）', body.includes('assets/analytics.js'));
  check('公告文案键进词典', body.includes('banner.title') || (await text('/assets/i18n.js')).body.includes('banner.title'));
  check('维护文案键进词典', (await text('/assets/i18n.js')).body.includes('maintenance.title'));

  const i18n = (await text('/assets/i18n.js')).body;
  for (const key of ['banner.close', 'banner.more', 'maintenance.default', 'maintenance.adminHint']) {
    check('i18n · ' + key, i18n.includes('"' + key + '"'));
  }
}

/* ---------------- 5. 后台面板（B2–B17） ---------------- */
console.log('— 后台 admin.html（B2–B17） —');
{
  const { status, body } = await text('/admin.html');
  check('admin.html → 200', status === 200, `got ${status}`);

  /* 15 个 tab 与对应面板 */
  const tabs = ['posts', 'review', 'comments', 'spam', 'reports', 'media', 'stats',
    'settings', 'notify', 'data', 'users', 'admins', 'audit', 'system'];
  for (const tab of tabs) {
    check(`tab 存在 · ${tab}`, body.includes(`data-admin-tab="${tab}"`));
    check(`面板存在 · ${tab}`, body.includes(`data-admin-panel="${tab}"`));
  }

  for (const [label, needle] of [
    ['批量栏', 'data-bulkbar'],
    ['批量动作容器', 'data-bulk-actions'],
    ['批量取消选择', 'data-bulk-clear'],
    /* B2 */
    ['文章表全选', 'data-post-select-all'],
    ['评论表全选', 'data-comment-select-all'],
    ['举报表全选', 'data-report-select-all'],
    ['用户表全选', 'data-user-select-all'],
    ['垃圾表全选', 'data-spam-select-all'],
    ['勾选列表头', 'admin-table__pick'],
    ['卡片化表格', 'admin-table--cards'],
    /* B8 */
    ['文章状态含定时', '<option value="scheduled">定时未到</option>'],
    ['文章状态含已审过', '<option value="reviewed">已审过</option>'],
    ['状态含待审改稿', '<option value="edit_pending">待审改稿</option>'],
    ['排序/定时列', '排序 / 定时'],
    /* B11 */
    ['用户筛选含编辑', '<option value="editor">编辑</option>'],
    ['两步验证列', '两步验证'],
    ['发布数列', '发布数'],
    /* B12 */
    ['审计搜索', 'data-audit-search'],
    ['审计动作筛选', 'data-audit-action'],
    ['审计操作者筛选', 'data-audit-actor'],
    ['审计起止日期', 'data-audit-from'],
    ['审计导出', 'data-audit-export'],
    ['审计分页', 'data-audit-pager'],
    /* B17 */
    ['垃圾阈值显示', 'data-spam-hold'],
    ['垃圾队列表体', 'data-admin-spam'],
    ['垃圾队列分页', 'data-spam-pager'],
    /* B7 */
    ['媒体搜索', 'data-media-search'],
    ['媒体分组', 'data-media-folder'],
    ['媒体上传', 'data-media-upload'],
    ['媒体网格', 'data-media-grid'],
    /* B9 / B10 */
    ['统计天数', 'data-stats-days'],
    ['趋势图容器', 'data-stats-chart'],
    ['趋势汇总', 'data-trend-views'],
    ['热门文章图', 'data-top-posts'],
    ['访问 PV', 'data-an-pv'],
    ['访问 UV', 'data-an-uv'],
    ['访问走势', 'data-an-series'],
    ['热门页面', 'data-an-paths'],
    ['来源站点', 'data-an-referrers'],
    ['访客环境', 'data-an-uas'],
    /* B6 / B15 */
    ['站点标题设置', 'data-set="site.title"'],
    ['公告开关', 'data-set-flag="banner.announcement"'],
    ['公告语气', 'data-key="level"'],
    ['维护开关', 'data-set-flag="banner.maintenance"'],
    ['风控阈值', 'data-set-num="comment.auto_hide_score"'],
    /* B3 / B16 */
    ['站外投递开关', 'data-set-bool="notify.enabled"'],
    ['Webhook 地址', 'data-set="notify.webhook_url"'],
    ['投递密钥', 'data-set="notify.worker_secret"'],
    ['随机生成密钥', 'data-notify-gen-secret'],
    ['事件勾选', 'data-notify-kinds'],
    ['模板子标签', 'data-tpl-tab="mail.tpl.comment"'],
    ['模板标题', 'data-tpl-subject'],
    ['模板正文', 'data-tpl-body'],
    ['恢复默认模板', 'data-tpl-reset'],
    ['投递队列', 'data-admin-outbox'],
    ['worker 运行状态', 'data-notify-worker'],
    ['队列筛选', 'data-outbox-filter="failed"'],
    ['全部重试', 'data-outbox-retry-all'],
    /* B5 */
    ['导出范围', 'data-export-kind'],
    ['执行导出', 'data-export-run'],
    ['导出并存云端', 'data-export-to-cloud'],
    ['备份列表', 'data-backup-list'],
    /* B13 / B14 */
    ['2FA 状态', 'data-twofa-state'],
    ['2FA 密钥', 'data-twofa-secret'],
    ['2FA 动态码', 'data-twofa-code'],
    ['2FA 确认开启', 'data-twofa-enable'],
    ['健康卡片区', 'data-health-grid'],
    ['健康刷新', 'data-health-refresh'],
    ['需要留意', 'data-health-attention'],
    /* 编辑器（A3 / A4 / A5 复用） */
    ['后台发布时间字段', 'data-admin-schedule'],
    ['后台预览面板', 'data-preview-panel'],
    ['后台修订面板', 'data-revisions-panel'],
    ['后台编辑器可收起', 'data-editor-close'],
    ['引用 chart.js', 'assets/chart.js'],
    ['引用 admin-ext.js', 'assets/admin-ext.js'],
    ['引用 write-ext.js', 'assets/write-ext.js'],
  ]) check(label, body.includes(needle));

  check('后台没有残留的 markdown 粗体写法', absent(body, '**再**'));
}

/* ---------------- 6. 无头 Chrome 扫 console ---------------- */
console.log('— 无头 Chrome console —');
if (!CHROME) {
  console.log('  SKIP 未找到 Chrome（设 CHROME_BIN 可指定）— 静态断言已覆盖模板/脚本层面');
} else {
  const pages = ['/', '/index.html', '/write.html', '/admin.html', '/preview.html',
    '/login.html', '/account.html', '/posts.html', '/archive.html', '/tags.html'];
  for (const page of pages) {
    const { err, out } = await runChrome(BASE + page);
    /* 本地 127.0.0.1 上云端请求必然 403 / CORS 失败，这是预期噪音，不算问题 */
    const noisy = /403|Failed to load resource|ERR_|net::|CORS|Access-Control|the server responded/i;
    /* 只认页面自身的 JS 报错：--enable-logging=stderr 下页面错误一定带 CONSOLE( 标记；
       Chrome 内部日志（Extension error / gcm / updater / named pipe / load_error_reporter 等）
       不带这个标记，但常含 "error" 字样，所以必须用标记而非关键词来过滤。 */
    const bad = err.split('\n').filter((line) => {
      if (!/CONSOLE\(/.test(line)) return false;
      if (!/ERROR|Uncaught|SyntaxError|TypeError|ReferenceError/i.test(line)) return false;
      if (noisy.test(line)) return false;
      return true;
    });
    check(`${page} 无 JS 异常`, bad.length === 0, bad.slice(0, 3).join(' | '));
    check(`${page} 有渲染出 DOM`, out.includes('<body'));
  }
}

/* ---------------- 7. Python 侧：构建期产物 ---------------- */
console.log('— 构建期产物 —');
{
  const info = await text('/assets/build-info.json');
  check('build-info.json → 200', info.status === 200, `got ${info.status}`);
  try {
    const parsed = JSON.parse(info.body);
    check('build-info 有 generatedAt', typeof parsed.generatedAt === 'string');
    check('build-info 有文章计数', parsed.posts && typeof parsed.posts.total === 'number');
    check('build-info 记录了 cloud', typeof parsed.cloud === 'boolean');
  } catch (e) {
    check('build-info 是合法 JSON', false, e.message);
  }
}

/* ---------------- 8. 云函数 ws-notify（B3 的投递端，不在 dist 里） ---------------- */
console.log('— 云函数 ws-notify —');
{
  const fnDir = path.resolve(import.meta.dirname, '..', 'cloudfunctions', 'ws-notify');
  const read = (name) => {
    const p = path.join(fnDir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  check('index.js 存在', read('index.js').length > 0);
  check('pgrest.js 存在', read('pgrest.js').length > 0);
  check('package.json 存在', read('package.json').length > 0);

  const idx = read('index.js');
  for (const [label, needle] of [
    ['读投递配置', 'notify_worker_config'],
    ['领取队列', 'notify_outbox_claim'],
    ['回执', 'notify_outbox_ack'],
    ['心跳', 'notify_worker_beat'],
    ['先看配置再领取（不白烧尝试次数）', 'no_channel'],
    ['Webhook 投递', 'postJson'],
    ['HMAC 签名', "createHmac('sha256'"],
    ['邮件通道（惰性依赖）', "require('nodemailer')"],
    ['密钥从环境变量取', 'NOTIFY_WORKER_SECRET'],
    ['调试入口 probe', 'probe'],
  ]) check('ws-notify · ' + label, idx.includes(needle));

  const pg = read('pgrest.js');
  check('ws-notify · 走站点 RPC 通道', pg.includes('/.cloud/database/rest/rpc/'));
  check('ws-notify · 用发布密钥鉴权', pg.includes('x-wb-webapp-access-key'));

  let pkg = {};
  try { pkg = JSON.parse(read('package.json')); } catch (e) { /* 下面断言会报 */ }
  check('ws-notify · package.json 合法', !!pkg.name);
  check('ws-notify · 入口 index.js', pkg.main === 'index.js');
  check('ws-notify · 声明 nodemailer', !!(pkg.dependencies && pkg.dependencies.nodemailer));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
server.close();
process.exit(fail ? 1 : 0);
