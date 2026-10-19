/* 通知中心渲染链路浏览器验证：
 * 用真实产物中的页面骨架 + 桩化 WSBlogCloud，跑 notifications.js 与 notify.js，
 * 断言列表渲染、未读徽标、加载更多、HTML 转义等行为。
 *
 * 顺序说明：cloud.js 会覆写 window.WSBlogCloud，所以桩必须放在 cloud.js 之后、
 * notify.js / notifications.js 之前（真实站点里这两个脚本也是后加载的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startStaticServer, probeChrome, resolveChrome } from './_serve.mjs';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
/* Chrome 路径解析 + 真·可用性探测：探测不过就直接跳过整段 DOM 断言。 */
const CHROME = await probeChrome(resolveChrome());
/* 自带静态服务，不再依赖外部 `build.py --serve --port 4199`（CI 里没有那一步）。 */
const srv = await startStaticServer(4199);
const BASE = srv.base;

const page = fs.readFileSync(`${DIST}/notifications.html`, 'utf8');
const mainMatch = /<main id="main">([\s\S]*?)<\/main>/.exec(page);
if (!mainMatch) {
  console.error('找不到 <main>，产物结构可能变了');
  process.exit(1);
}

const STUB = `
<script>
  var NOTIFS = [];
  for (var i = 1; i <= 25; i++) {
    NOTIFS.push({
      id: i,
      kind: i % 5 === 0 ? 'post_approved' : (i % 3 === 0 ? 'reply' : 'comment'),
      title: '第 ' + i + ' 条通知 & <b>标题</b>',
      body: '内容摘要 ' + i,
      link: 'posts/demo-' + i + '.html',
      actor_name: '读者' + i,
      post_slug: 'demo-' + i,
      read_at: i > 5 ? '2026-10-13T10:00:00Z' : null,
      created_at: new Date(Date.now() - i * 3600 * 1000).toISOString()
    });
  }
  var calls = [];
  window.__CALLS__ = calls;
  window.WSBlogCloud = {
    root: '',
    escapeHtml: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
      });
    },
    toast: function () {},
    formatDate: function () { return '2026-10-13'; },
    currentUser: function () { return { id: 'u1' }; },
    booted: function () { return Promise.resolve(); },
    onSessionChange: function () {},
    db: function () {
      return {
        rpc: function (name, args) {
          calls.push({ name: name, args: args || null });
          if (name === 'my_notifications') {
            var limit = (args && args.p_limit) || 20;
            var offset = (args && args.p_offset) || 0;
            var unreadOnly = !!(args && args.p_unread);
            var unread = NOTIFS.filter(function (n) { return !n.read_at; });
            var pool = unreadOnly ? unread : NOTIFS;
            return Promise.resolve({ data: {
              total: NOTIFS.length,
              unread: unread.length,
              shown: pool.length,
              rows: pool.slice(offset, offset + limit)
            } });
          }
          if (name === 'notify_unread_count') return Promise.resolve({ data: 20 });
          if (name === 'notify_mark_read') return Promise.resolve({ data: 1 });
          if (name === 'notify_clear') return Promise.resolve({ data: 1 });
          return Promise.resolve({ data: null });
        }
      };
    }
  };
</script>`;

const harness = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>probe2</title></head>
<body>
<header class="site-header"><div class="wrap site-header__inner">
  <span class="header__spacer"></span>
  <div class="header__actions"><div class="notify-slot" data-notify-slot hidden></div></div>
</div></header>
${mainMatch[1]}
<pre id="__out">pending</pre>
<script>window.__ROOT__='';</script>
<script src="assets/cloud.js"></script>
${STUB}
<script src="assets/notify.js"></script>
<script src="assets/notifications.js"></script>
<script>
  setTimeout(function () {
    var list = document.querySelector('[data-notify-list]');
    var rows = document.querySelectorAll('[data-notify-list] .notif');
    var bell = document.querySelector('.notify-bell');
    var badge = document.querySelector('.notify-bell__badge');
    var more = document.querySelector('[data-notify-more]');
    var chip = document.querySelector('[data-notify-unread-chip]');
    document.getElementById('__out').textContent = 'OUT:' + JSON.stringify({
      rows: rows.length,
      firstUnread: rows.length ? /is-unread/.test(rows[0].className) : false,
      escaped: list.innerHTML.indexOf('<b>标题</b>') === -1,
      hasBell: !!bell,
      badge: badge ? badge.textContent : null,
      moreHidden: more ? more.hasAttribute('hidden') : null,
      chip: chip ? chip.textContent : null,
      firstHref: rows.length ? (rows[0].querySelector('[data-notif-open]') || {}).getAttribute('href') : null
    });
    document.title = 'PROBE2 DONE';
  }, 2500);
</script>
</body></html>`;

/* 探针页写进 dist/ 是因为要让它和站点共用同一套相对路径与脚本。
 * 但它必须**走得干净**：dist/ 是发布产物，残留文件会被 sites_deploy 原样带上线
 * （2026-10-19 实拍到线上产物里躺着 __probe_notify.html）。
 * 所以凡是有可能提前退出（SKIP / 取不到结果 / 断言失败）的地方都要清理，
 * 且清理放在写文件之后立刻登记，避免以后加分支时又漏。 */
const PROBE_HTML = `${DIST}/__probe_notify.html`;
fs.writeFileSync(PROBE_HTML, harness);

let cleaned = false;
function cleanProbe() {
  if (cleaned) return;
  cleaned = true;
  try { fs.unlinkSync(PROBE_HTML); } catch (e) { /* 已经不在了就算了 */ }
}
process.on('exit', cleanProbe);
process.on('SIGINT', () => { cleanProbe(); process.exit(130); });

function runChrome(url) {
  return new Promise((resolve) => {
    const p = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--user-data-dir=${process.env.TEMP}/wsblog-probe2-${Date.now()}`,
      '--virtual-time-budget=20000', '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out));
  });
}

if (!CHROME) {
  console.log('  SKIP 浏览器不可用（设 CHROME_BIN 可指定）— 通知渲染断言跳过');
  console.log('\n结果：0 通过 / 0 失败（跳过）');
  await srv.close();
  process.exit(0);
}

const dom = await runChrome(`${BASE}/__probe_notify.html`);
const m = /OUT:(\{[^<]*\})/.exec(dom);
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

if (!m) {
  console.log('  FAIL 未取到渲染结果');
  console.log(dom.slice(0, 800));
  await srv.close();
  process.exit(1);
}
const r = JSON.parse(m[1]);
check('列表按页大小渲染 20 条', r.rows === 20, String(r.rows));
check('未读条目带 is-unread 标记', r.firstUnread === true);
check('标题已 HTML 转义（无 XSS）', r.escaped === true);
check('顶栏铃铛已渲染', r.hasBell === true);
check('铃铛显示未读数', r.badge === '5', String(r.badge));
check('「加载更多」可见（还有第 21~25 条）', r.moreHidden === false, String(r.moreHidden));
check('未读汇总数回显到筛选芯片', r.chip === '5', String(r.chip));
check('「查看」链接指向文章页', r.firstHref === 'posts/demo-1.html', String(r.firstHref));

await srv.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
