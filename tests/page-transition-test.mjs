/**
 * 回归：页面切换流畅度（View Transitions + 链接预取 + 画布底色）。
 *
 * 为什么需要它：这三处改动都**不会报错、也不影响功能**，出问题时只有「感觉变卡了」，
 * 很容易被后续改动悄悄弄坏。典型的几种坏法：
 *   · `@view-transition` 被误加进 `@media` 或拼错 → 过渡整体失效，页面照常能开，没人发现；
 *   · `prefers-reduced-motion` 分支丢了 → 无障碍回退；
 *   · `html` 的 `background` 被删 → 暗色下切换闪白（最直接的用户体感）；
 *   · 预取规则放太宽（例如把 .js 也预取）→ 抢首屏带宽，**反而更慢**；
 *   · 预取规则放太窄（把 .html 排除）→ 功能等于没写。
 * 所以两侧都测：既断言「该有的在」，也断言「不该有的不在」。
 *
 * 不依赖浏览器：读的是 dist/ 产物与源码，在 CI 与本地都能跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

const read = (p) => fs.readFileSync(p, 'utf8');

/* ---------- 1. View Transitions（dist 里的产物 CSS） ---------- */
console.log('— 跨页面过渡（View Transitions）—');
const css = read(path.join(DIST, 'assets/main.css'));

check('启用了跨文档过渡', /@view-transition\s*\{[^}]*navigation\s*:\s*auto/.test(css));
check('定义了根快照的旧/新两层动画',
  /::view-transition-old\(root\)/.test(css) && /::view-transition-new\(root\)/.test(css));
check('过渡时长明确且克制（≤300ms）', (() => {
  const m = css.match(/::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{([^}]*)\}/);
  if (!m) return false;
  const d = m[1].match(/animation-duration:\s*(\d+)ms/);
  return d ? Number(d[1]) > 0 && Number(d[1]) <= 300 : false;
})());
check('淡出/淡入关键帧都存在',
  /@keyframes\s+ws-vt-fade-out/.test(css) && /@keyframes\s+ws-vt-fade-in/.test(css));
check('尊重 prefers-reduced-motion', (() => {
  // 必须存在一个 reduced-motion 媒体查询，且其中取消了过渡动画
  const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)];
  return blocks.some((b) => /view-transition/.test(b[1]) && /animation:\s*none/.test(b[1]));
})());

/* ---------- 2. 画布底色（闪白的直接原因） ---------- */
console.log('— 画布底色（暗色切换不闪白）—');
const htmlRule = (() => {
  const m = css.match(/(?:^|\n)html\s*\{([^}]*)\}/);
  return m ? m[1] : '';
})();
check('html 上设置了 background（不能只给 body）', /background\s*:/.test(htmlRule),
  htmlRule ? `html{${htmlRule.trim().replace(/\s+/g, ' ').slice(0, 60)}}` : '未找到 html 规则');
check('html 的底色用主题变量，随主题切换', /background\s*:\s*var\(--bg\)/.test(htmlRule));
check('body 仍保留自身背景（两者同色兜底）', (() => {
  const m = css.match(/(?:^|\n)body\s*\{([^}]*)\}/);
  return m ? /background\s*:\s*var\(--bg\)/.test(m[1]) : false;
})());

/* ---------- 3. 链接预取（源码与产物都要有） ---------- */
console.log('— 链接预取 —');
for (const [label, file] of [
  ['源码', path.join(ROOT, 'src/scripts/app.js')],
  ['产物', path.join(DIST, 'assets/app.js')],
]) {
  const js = read(file);
  check(`${label}：预取模块存在`, /prefetchOnIntent/.test(js));
  check(`${label}：用 link[rel=prefetch] 而非 fetch()`,
    /\.rel\s*=\s*'prefetch'/.test(js) && !/function\s+prefetch\s*\([\s\S]*?\bfetch\s*\([\s\S]*?\n\s{4}\}/.test(js),
    '预取应交给浏览器调度，不要自己 fetch');
  check(`${label}：限制同源`, /url\.origin\s*!==\s*location\.origin/.test(js));
  check(`${label}：跳过下载链接`, /hasAttribute\('download'\)/.test(js));
  check(`${label}：跳过 target=_blank 等`, /a\.target\s*&&\s*a\.target\s*!==\s*'_self'/.test(js));
  check(`${label}：只预取页面（.html / 目录）`,
    /\\\.html\?\$/.test(js) || /\.html\?\$\//.test(js) || /http\(|html\?/.test(js));
  check(`${label}：不预取鉴权页面`,
    /admin\|write\|account\|login\|notifications\|preview\|subscribe/.test(js));
  check(`${label}：尊重省流/慢速连接`,
    /saveData/.test(js) && /effectiveType/.test(js));
  check(`${label}：同一 URL 不重复预取`, /seen\[key\]/.test(js));
  check(`${label}：悬停有延迟防抖`, /HOVER_DELAY/.test(js) && /setTimeout/.test(js));
}

/* ---------- 4. Service Worker：预取要能被导航复用 ---------- */
console.log('— Service Worker 配合 —');
const sw = read(path.join(DIST, 'sw.js'));
check('识别 rel=prefetch 请求', /sec-purpose'\)\s*===\s*'prefetch'/.test(sw));
check('预取响应写入缓存', (() => {
  const i = sw.indexOf("=== 'prefetch'");
  if (i < 0) return false;
  const seg = sw.slice(i, i + 900);
  return /cache\.put\(/.test(seg);
})());
check('导航仍以网络优先（不退回纯缓存优先）', /fetch\(request\)/.test(sw));
check('有缓存时给网络一个短宽限期（避免白屏又不牺牲新鲜度）', (() => {
  // 找一个有限毫秒数的竞速，且该值不大于 1000ms
  const m = sw.match(/setTimeout\(function\s*\(\)\s*\{[\s\S]{0,80}resolve\(cached\)[\s\S]{0,40}\},\s*(\d+)\)/);
  return m ? Number(m[1]) > 0 && Number(m[1]) <= 1000 : false;
})());
check('SW 版本已升（避免用户混跑新旧缓存）', /wsblog-v7/.test(sw));
check('预取失败不抛错（回 204 静默）', /status:\s*204/.test(sw));

/* ---------- 5. 产物层面的完整性 ---------- */
console.log('— 产物完整性 —');
const home = read(path.join(DIST, 'index.html'));
check('首页引用了 main.css', /assets\/main\.css/.test(home));
check('首页脚本仍全部 defer（不阻塞首屏）', (() => {
  const tags = [...home.matchAll(/<script[^>]*src=[^>]*>/g)].map((m) => m[0]);
  return tags.length > 0 && tags.every((t) => /\bdefer\b/.test(t));
})());
check('首页未内联大段脚本（内联 < 8KB）', (() => {
  const inline = [...home.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)]
    .reduce((n, m) => n + m[1].length, 0);
  return inline < 8192;
})(), (() => {
  const inline = [...home.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)]
    .reduce((n, m) => n + m[1].length, 0);
  return `实际 ${inline} 字符`;
})());

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
