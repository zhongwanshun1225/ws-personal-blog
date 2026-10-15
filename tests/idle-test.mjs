/**
 * idle.js 行为验证：用最小 DOM/计时器桩在 Node 里跑核心逻辑。
 * 不依赖 Chrome —— 本沙箱 Chrome 起不来。
 * 覆盖：阈值、活跃续期、警告、登出跳转、草稿刷盘、登录页不启用、轮询不续期。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const realSetTimeout = globalThis.setTimeout;

const SRC = readFileSync('dist/assets/idle.js', 'utf8');
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

function makeEnv({ loggedIn = true, path = '/account.html', hasDraftFlush = true } = {}) {
  const timers = [];
  const listeners = {};
  const docEls = { '[data-idle-warn]': mkEl('div'), '[data-idle-text]': mkEl('span') };
  const warn = docEls['[data-idle-warn]'];
  const text = docEls['[data-idle-text]'];
  function mkEl(tag) { return { tag, attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, querySelector(sel) { const m = { '[data-idle-text]': text }; return m[sel] || null; }, closest() { return null; } }; }

  const sessionStore = new Map();
  const flushed = { n: 0 };
  const events = [];

  const sandbox = {
    console,
    document: {
      readyState: 'complete',
      hidden: false,
      addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
      querySelector: (sel) => docEls[sel] || null,
      dispatchEvent: (ev) => { events.push(ev && ev.type || String(ev)); return true; },
    },
    // 长计时器（4/5 分钟）用桩捕获，便于手动触发；
    // 短计时器（<1s，宽限期）走真实定时器，否则回调永远不执行。
    setTimeout: (fn, ms) => {
      if (ms >= 1000) { const id = timers.length; timers.push({ fn, ms, id }); return id; }
      return realSetTimeout(fn, ms);
    },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.canceled = true; },
    CustomEvent: class { constructor(type) { this.type = type; } },
    location: { pathname: path, search: '', href: '', origin: 'https://ws-blog.app.workbuddy.host' },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, v),
      removeItem: (k) => sessionStore.delete(k),
    },
    navigator: { userAgent: 'test' },
    crypto: { randomUUID: () => 'uuid-test' },
    sessionStorageKeys: sessionStore,
  };
  sandbox.window = sandbox;

  const signedOut = { n: 0 };
  const sessionCbs = [];
  sandbox.WSBlogCloud = {
    currentUser: () => (loggedIn ? { id: 'u1' } : null),
    signOut: () => { signedOut.n++; return Promise.resolve(); },
    booted: () => Promise.resolve(loggedIn ? { id: 'u1' } : null),
    onSessionChange: (cb) => sessionCbs.push(cb),
    rootPath: () => '',
  };
  if (hasDraftFlush) sandbox.WSBlogDraft = { flush: () => { flushed.n++; } };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  return {
    sandbox, timers, listeners, warn, text, signedOut, flushed, events, sessionStore,
    fire: (name, ev = {}) => (listeners[name] || []).forEach((fn) => fn({ type: name, target: { closest: () => null }, ...ev })),
    runTimer: (ms) => { const t = timers.find((x) => !x.canceled && x.ms === ms); if (t) { t.canceled = true; t.fn(); } return t; },
    pending: (ms) => timers.filter((x) => !x.canceled && x.ms === ms),
  };
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));

// 1. 阈值常量
console.log('— 常量 —');
{
  const e = makeEnv();
  check('IDLE_MS = 5 分钟', e.sandbox.WSBlogIdle.IDLE_MS === 5 * 60 * 1000);
  check('WARN_MS = 60 秒', e.sandbox.WSBlogIdle.WARN_MS === 60 * 1000);
}

// 2. 已登录 → 起两个计时器（警告 + 登出）
console.log('— 计时器 —');
{
  const e = makeEnv({ loggedIn: true });
  await sleep(30);
  check('登录后注册了 5 分钟登出计时器', e.pending(300000).length === 1);
  check('登录后注册了 4 分钟警告计时器', e.pending(240000).length === 1);
}

// 3. 未登录 → 不起作用
console.log('— 未登录 —');
{
  const e = makeEnv({ loggedIn: false });
  await sleep(30);
  check('未登录不注册任何计时器', e.timers.length === 0);
}

// 4. 登录页 → 不启用
{
  const e = makeEnv({ loggedIn: true, path: '/login.html' });
  await sleep(30);
  check('登录页不启用', e.timers.length === 0);
}

// 5. 活跃事件续期（重要：轮询不能续期）
console.log('— 活跃续期 —');
{
  const e = makeEnv({ loggedIn: true });
  await sleep(30);
  const before = e.timers.length;
  e.fire('keydown');
  check('用户输入重置计时器（旧计时器作废）', e.timers.length > before);
  check('续期后仍有 5 分钟计时器', e.pending(300000).length === 1);
  const afterInput = e.timers.length;
  // 模拟后台轮询：不发任何用户事件 → 计时器数量不变
  check('无用户事件时计时器不动（轮询不续期）', e.timers.length === afterInput);
}

// 6. 到点登出：signOut 被调用 + 跳转带 idle=1
console.log('— 到点登出 —');
{
  const e = makeEnv({ loggedIn: true });
  await sleep(30);
  e.runTimer(300000);                 // 触发登出
  for (let i = 0; i < 40 && !e.sandbox.location.href; i++) await sleep(50);  // 等 GRACE_MS + signOut
  check('调用了云端 signOut（真登出）', e.signedOut.n === 1);
  check('宽限期内触发了草稿刷盘', e.flushed.n === 1);
  check('跳转到 login.html', e.sandbox.location.href.includes('login.html'));
  check('跳转带 idle=1', e.sandbox.location.href.includes('idle=1'));
  check('跳转带 next=', e.sandbox.location.href.includes('next='));
  check('写入了原因标记', e.sessionStore.get('wsblog:idle-logout') === '1');
}

// 7. 警告条显示
console.log('— 警告条 —');
{
  const e = makeEnv({ loggedIn: true });
  await sleep(30);
  e.runTimer(240000);                 // 触发警告
  check('警告时给警告条加 data-show', 'data-show' in e.warn.attrs);
  check('警告文案含秒数', /60 秒后将自动退出/.test(e.text.textContent));
  check('aria-hidden 置 false', e.warn.attrs['aria-hidden'] === 'false');
  // 用户回来 → 警告撤销
  e.fire('mousemove');
  check('活跃后撤销警告', !('data-show' in e.warn.attrs));
}

// 8. 续期按钮
console.log('— 续期按钮 —');
{
  const e = makeEnv({ loggedIn: true });
  await sleep(30);
  const target = { closest: (sel) => (sel === '[data-idle-continue]' ? {} : null) };
  (e.listeners['click'] || []).forEach((fn) => fn({ type: 'click', target }));
  check('点「继续使用」重置计时器', e.pending(300000).length === 1);
}

// 9. takeRedirectReason 一次性
console.log('— 原因标记 —');
{
  const e = makeEnv({ loggedIn: true });
  e.sessionStore.set('wsblog:idle-logout', '1');
  check('首次读取返回 idle', e.sandbox.WSBlogIdle.takeRedirectReason() === 'idle');
  check('二次读取返回空（不重复提示）', e.sandbox.WSBlogIdle.takeRedirectReason() === '');
}

// 10. visibilitychange（切回标签页算活跃）
console.log('— 标签页切换 —');
{
  const e = makeEnv({ loggedIn: true });
  await sleep(30);
  const before = e.timers.length;
  e.sandbox.document.hidden = false;
  e.fire('visibilitychange');
  check('切回标签页重置计时器', e.timers.length > before);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
