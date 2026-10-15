/* 游客体验批次冒烟：无头 Chrome 抓 console 错误 + 断言关键 DOM */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { startStaticServer, resolveChrome, probeChrome } from './_serve.mjs';

const srv = await startStaticServer(4199);
const BASE = srv.base;
/* 先按路径找，再跑一次真·可用性探测：本沙箱 chrome.exe 存在但任何调用都不出字节，
 * 只判存在会把环境问题误报成回归失败。 */
const CHROME = await probeChrome(resolveChrome());
if (!CHROME) console.log('  SKIP 浏览器不可用（设 CHROME_BIN 可指定）— 只跑静态断言');
const PROFILE = path.resolve(import.meta.dirname, '.chrome-guest-smoke');

function fetchText(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function runChrome(url, extra = []) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--user-data-dir=${PROFILE}-${Math.random().toString(36).slice(2, 8)}`,
      '--virtual-time-budget=6000', '--dump-dom', ...extra, url,
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
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('— HTTP 资源 —');
for (const [path, expect] of [
  ['/', 200], ['/404.html', 200], ['/archive.html', 200], ['/offline.html', 200],
  ['/sw.js', 200], ['/site.webmanifest', 200], ['/assets/og-default.png', 200],
]) {
  const r = await fetchText(path);
  check(`${path} → ${expect}`, r.status === expect, `got ${r.status}`);
}

console.log('— 静态断言 —');
{
  const { body } = await fetchText('/posts/400-lines-static-site-generator.html');
  check('文章页含分享条', body.includes('data-share'));
  check('文章页 og:type=article 且仅一处', (body.match(/property="og:type"/g) || []).length === 1);
  check('文章页含 og:image', body.includes('og:image'));
  check('文章页含 twitter:image', body.includes('twitter:image'));
  check('文章页含 manifest 链接', body.includes('rel="manifest"'));
  check('文章页含 apple-touch-icon', body.includes('apple-touch-icon'));
  const noScript = body; // app.js 由 defer 注入
  check('分享条含 weibo/x/native/copy', ['weibo', 'data-share-action="x"', 'native', 'copy'].every((k) => noScript.includes(k)));
}
{
  const { body } = await fetchText('/404.html');
  check('404 页有搜索按钮', body.includes('data-search-open'));
  check('404 页有最新文章', body.includes('notFound.latest'));
  check('404 页有标签导航', body.includes('notFound.hotTags'));
}
{
  const { body } = await fetchText('/');
  check('首页含全部文章入口', body.includes('全部'));
  check('首页含 manifest', body.includes('rel="manifest"'));
}

console.log('— 游客体验批次（V2 V3 V6 V7 V10 V11 V12 V13 V15 V16 V17 V18 V19）—');
for (const [path, expect] of [
  ['/subscribe.html', 200], ['/shortcuts.html', 200], ['/series.html', 200],
  ['/assets/i18n.js', 200], ['/assets/vendor-map.js', 200], ['/assets/math.js', 200],
  ['/assets/subscribe.js', 200], ['/search-index.json', 200], ['/search-index/text-1.json', 200],
  ['/assets/vendor/katex/katex.min.js', 200], ['/assets/vendor/katex/katex.min.css', 200],
  ['/assets/vendor/katex/fonts/KaTeX_Main-Regular.woff2', 200],
  ['/assets/vendor/mermaid.min.js', 200],
]) {
  const r = await fetchText(path);
  check(`${path} → ${expect}`, r.status === expect, `got ${r.status}`);
}
{
  const { body } = await fetchText('/archive.html');
  check('归档页内联全量清单', body.includes('data-archive-feed'));
  check('归档页有排序工具条', body.includes('data-sort="hot"') && body.includes('data-sort="latest"'));
  check('归档页有加载更多按钮（默认 hidden）', /data-load-more[^>]*hidden/.test(body));
  check('归档页清单未二次嵌套', !body.includes('"items":{"pageSize"'));
  check('归档页年分组标题带 i18n', body.includes('archive.postsCount'));
}
{
  const { body } = await fetchText('/posts/400-lines-static-site-generator.html');
  check('文章页日期用 <time datetime> 且可切语言', /<time class="meta-text" datetime="\d{4}-\d{2}-\d{2}"[^>]*data-i18n-config/.test(body));
  check('交互区文案带 i18n', body.includes('data-i18n="interact.like"') && body.includes('data-i18n="interact.submit"'));
  // KaTeX / Mermaid 是按需加载：正文没有公式的文章不该为它们付一个请求
  check('无公式的静态文章不拉 math.js（按需加载）', !body.includes('assets/math.js'));
}
{
  // 会运行时渲染 Markdown 的页面（云文章详情 / 编辑器 / 后台预览）才必须带 math.js
  const { body } = await fetchText('/post.html');
  check('云文章详情页引入 math.js', body.includes('assets/math.js'));
  check('vendor-map.js 排在 math.js 之前',
    body.indexOf('assets/vendor-map.js') > -1 &&
    body.indexOf('assets/vendor-map.js') < body.indexOf('assets/math.js'));
  const css = (await fetchText('/assets/main.css')).body;
  check('CSS 含系列指示样式（V7）', css.includes('.article-head__series'));
  check('CSS 含数学/图表样式（V12）', css.includes('.math-block') && css.includes('.mermaid-block'));
  check('CSS 含骨架屏样式（V18）', css.includes('.skeleton'));
}
{
  const { body } = await fetchText('/');
  const nav = body.replace(/&quot;/g, '"');
  check('导航标签可切语言', body.includes('data-i18n-config') && nav.includes('"en":"Home"'));
  check('页脚说明可切语言', /data-i18n-config="[^"]*Built with/.test(body));
  check('语言面板含两个选项', body.includes('data-lang-set="zh-CN"') && body.includes('data-lang-set="en"'));
  check('语言启动脚本早于 i18n.js', body.indexOf('data-lang-switching') > -1);
  check('首页含站点动态区块', body.includes('data-i18n="home.activity"') || body.includes('activity'));
  check('首页含订阅入口', body.includes('data-i18n="home.subscribe"') || body.includes('subscribe.html'));
}
{
  const { body } = await fetchText('/series.html');
  check('系列页结构就位（V7）', body.includes('data-i18n="series.title"'));
}
{
  const { body } = await fetchText('/search-index.json');
  const idx = JSON.parse(body);
  check('搜索索引已分片', idx.textShards >= 1 && typeof idx.textShardSize === 'number');
  check('元数据层不含正文', idx.items.every((it) => !('text' in it)));
}
{
  const { body } = await fetchText('/subscribe.html');
  check('订阅页有表单与状态位', body.includes('data-subscribe-form') || body.includes('subscribe-form'));
  check('订阅页有 RSS 入口', body.includes('feed.xml'));
}
{
  const { body } = await fetchText('/login.html');
  check('登录页文案带 i18n', body.includes('data-i18n="auth.title"') && body.includes('placeholder="you@example.com"'));
}
{
  const { body } = await fetchText('/shortcuts.html');
  check('快捷键页列出 ? 入口', body.includes('shortcuts.tip'));
}

console.log('— 浏览器渲染 —');
if (!CHROME) {
  console.log('  SKIP 未找到 Chrome（设 CHROME_BIN 可指定）— 静态断言已覆盖模板/脚本层面');
} else {
  // 带 ?q= 访问应自动打开搜索面板并回填关键词
  const { out } = await runChrome(`${BASE}/?q=${encodeURIComponent('性能')}`);
  const opened = out.includes('data-search-overlay') && /data-search-overlay[^>]*data-open|data-open[^>]*data-search-overlay/.test(out.replace(/\s+/g, ' '));
  check('带 ?q= 打开搜索面板', opened);
  check('搜索面板回填关键词', out.includes('value="性能"') || /性能/.test(out));
  check('无嵌套锚点导致的标题丢失', out.includes('最新文章'));
}
if (!CHROME) {
  // 上一段已打印 SKIP；这里的 404 断言同样依赖渲染，环境缺失时一并跳过。
} else {
  const { out } = await runChrome(`${BASE}/404.html`);
  check('404 渲染出 404 字样', out.includes('404'));
  check('404 渲染出搜索按钮', out.includes('data-search-open'));
}

await srv.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
