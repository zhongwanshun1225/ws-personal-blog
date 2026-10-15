/**
 * interact.js 评论楼中楼分组逻辑回归（Node 桩驱动，不进浏览器）。
 * 验证点：平铺行 → 顶层倒序 / 回复正序挂父 / 渲染含回复按钮与删除按钮 / XSS 转义。
 *
 * ⚠️ 第一版用正则「抽出函数体」再 new Function 跑，结果反复踩坑：
 * commentItem 是 IIFE 里的闭包，依赖 esc / t / withinEditWindow 等同层函数，
 * 抽一个就得把整条依赖链都抽出来（漏一个就 ReferenceError），改一次源码就修一次脚本。
 * 现改为**整个文件跑进 vm**：桩掉浏览器 API 与 WSBlogCloud，把 commentItem 通过
 * 文件末尾那段 `window.WSBlogInteract = {...}` 一起暴露出来（源码里加一行导出即可，
 * 不影响线上行为），这样闭包链天然完整，源码再改也不会假失败。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/scripts/interact.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

/* ---------- 浏览器环境桩 ---------- */
const noop = () => {};
function mkEl() {
  return {
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, removeAttribute: noop, getAttribute: () => null,
    addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    innerHTML: '', textContent: '', value: '', href: '', focus: noop, insertBefore: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
}
const doc = {
  readyState: 'complete',
  hidden: false,
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: (sel) => (sel === '[data-interact]' ? mkEl() : null),
  querySelectorAll: () => [],
  createElement: () => mkEl(),
  createTextNode: () => ({}),
  body: mkEl(),
  documentElement: mkEl(),
  cookie: '',
};
const store = new Map();

const sandbox = {
  console: { log: noop, warn: noop, error: noop },
  document: doc,
  location: { href: 'https://example.com/', pathname: '/posts/demo.html', search: '', origin: 'https://example.com' },
  navigator: { userAgent: 'test', clipboard: { writeText: () => Promise.resolve() } },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  sessionStorage: {
    getItem: (k) => (store.has('s:' + k) ? store.get('s:' + k) : null),
    setItem: (k, v) => store.set('s:' + k, String(v)),
    removeItem: (k) => store.delete('s:' + k),
  },
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: (fn) => { try { fn(0); } catch { /* ignore */ } return 0; },
  addEventListener: noop,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  Intl,
  Date, Math, JSON, Promise, Array, Object, String, Number, RegExp, Error, TypeError,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

/* WSBlogCloud 桩：commentItem 只用到 escapeHtml / root / currentUser 等少数几个。 */
sandbox.WSBlogCloud = {
  root: '',
  escapeHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  currentUser: () => ({ id: 'u1' }),
  toast: noop,
  formatDate: () => '2026-10-15',
  booted: () => Promise.resolve(),
  onSessionChange: noop,
  signOut: () => Promise.resolve(),
  rpc: () => Promise.resolve({ ok: true, rows: [] }),
  t: (key, fallback) => (fallback == null ? key : fallback),
};

vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: 'interact.js' });
} catch (e) {
  console.log('  FAIL interact.js 无法在桩环境里加载：' + e.message);
  process.exit(1);
}

/* 测试出口：优先用源码显式导出的 __test（见 interact.js 末尾），
 * 没有再退回 commentItem（说明导出被删了，用 FAIL 提醒而不是静默跳过）。 */
const mod = sandbox.WSBlogInteract || {};
const commentItem = mod.__test && mod.__test.commentItem;
if (typeof commentItem !== 'function') {
  console.log('  FAIL 未能取到 commentItem —— interact.js 末尾的 __test 导出可能被移除了');
  process.exit(1);
}

/* --- 测试 1：单条顶层评论 --- */
let html = commentItem({ id: 1, author_name: '小张', content: '你好', created_at: '', is_mine: true }, null);
check('T1 顶层评论 id', html.includes('data-comment="1"'));
check('T1 有回复按钮', html.includes('data-comment-reply="1"'));
check('T1 自己的评论有删除', html.includes('data-comment-delete="1"'));
check('T1 无回复时不渲染 replies', !html.includes('comment__replies'));

/* --- 测试 2：带子回复 --- */
html = commentItem({ id: 2, author_name: '站长', content: '回复内容', created_at: '', is_mine: false }, [
  { id: 3, author_name: '小李', content: '再回复', created_at: '', is_mine: false, parent_id: 2 },
]);
check('T2 渲染 replies 容器', html.includes('comment__replies'));
check('T2 子回复在容器内', html.includes('data-comment="3"'));
check('T2 非本人评论无删除', !html.includes('data-comment-delete="2"'));

/* --- 测试 3：XSS 转义 --- */
html = commentItem({ id: 4, author_name: '<img src=x onerror=alert(1)>', content: '内容', created_at: '', is_mine: false }, null);
check('T3 姓名已转义', !html.includes('<img src=x'));
check('T3 转义标记存在', html.includes('&lt;img'));

/* --- 分组逻辑（复刻 renderComments 的核心；rows 为 DB 倒序返回） --- */
const rows = [
  { id: 13, parent_id: null, created_at: 't4' },
  { id: 10, parent_id: null, created_at: 't3' },
  { id: 12, parent_id: 10, created_at: 't2' },
  { id: 11, parent_id: 10, created_at: 't1' },
];
const top = [], children = {};
rows.forEach((r) => (r.parent_id ? (children[r.parent_id] = children[r.parent_id] || []).push(r) : top.push(r)));
check('分组：顶层倒序（13 在前）', top.length === 2 && top[0].id === 13);
const replies = (children[10] || []).slice().reverse();
check('分组：回复正序（11→12）', replies.map((r) => r.id).join(',') === '11,12');

console.log(`\n楼中楼逻辑回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
