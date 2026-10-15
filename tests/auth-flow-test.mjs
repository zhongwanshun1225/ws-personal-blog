/**
 * 登录流程逻辑测试（不依赖真实浏览器）。
 *
 * 用最小 DOM 桩直接驱动 src/scripts/auth.js，覆盖：
 *   1. 普通账号登录   → 直接跳 next/首页
 *   2. 管理员账号登录 → 出现「选择进入身份」
 *   3. 选「普通用户」 → 身份切到 user，去 account（或 next）
 *   4. 选「后台管理」 → 身份切到 admin，去 admin.html
 *   5. 管理员登录后点「退出登录」 → 会话清零
 *
 * 用法：node tests/auth-flow-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/* ---------------- 最小 DOM 桩 ---------------- */

function makeEl(attrs = {}) {
  const el = {
    attrs: Object.assign({}, attrs),
    listeners: {},
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
  };
  el.classList = { toggle() {}, add() {}, remove() {} };
  el.setAttribute = (k, v) => {
    el.attrs[k] = String(v);
  };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.removeAttribute = (k) => {
    delete el.attrs[k];
  };
  el.hasAttribute = (k) => k in el.attrs;
  el.addEventListener = (t, f) => {
    (el.listeners[t] = el.listeners[t] || []).push(f);
  };
  el.click = () => (el.listeners.click || []).forEach((f) => f({}));
  el.fire = (t, ev) => (el.listeners[t] || []).forEach((f) => f(ev || { preventDefault() {} }));
  el.focus = () => {};
  return el;
}

function buildDom() {
  const single = {
    '[data-auth-form]': makeEl({ 'data-auth-form': '' }),
    '[name="email"]': makeEl({ name: 'email' }),
    '[name="password"]': makeEl({ name: 'password' }),
    '[name="code"]': makeEl({ name: 'code' }),
    '[name="signupPassword"]': makeEl({ name: 'signupPassword' }),
    '[data-send-code]': makeEl({ 'data-send-code': '' }),
    '[data-auth-submit]': makeEl({ 'data-auth-submit': '' }),
    '[data-auth-error]': makeEl({ 'data-auth-error': '', hidden: '' }),
    '[data-auth-notice]': makeEl({ 'data-auth-notice': '', hidden: '' }),
    '[data-auth-form-wrap]': makeEl({ 'data-auth-form-wrap': '' }),
    '[data-identity-pick]': makeEl({ 'data-identity-pick': '', hidden: '' }),
    '[data-signed-in]': makeEl({ 'data-signed-in': '', hidden: '' }),
    '[data-pick-email]': makeEl({ 'data-pick-email': '' }),
    '[data-pick-signout]': makeEl({ 'data-pick-signout': '' }),
    '[data-signed-in-name]': makeEl({}),
    '[data-signed-in-mail]': makeEl({}),
    '[data-signed-in-role]': makeEl({}),
    '[data-signed-in-admin]': makeEl({ hidden: '' }),
    '[data-signed-in-switch]': makeEl({ hidden: '' }),
    '[data-signed-in-signout]': makeEl({}),
  };
  const multi = {
    '[data-tab]': [makeEl({ 'data-tab': 'password' }), makeEl({ 'data-tab': 'otp' })],
    '[data-panel]': [makeEl({ 'data-panel': 'password' }), makeEl({ 'data-panel': 'otp', hidden: '' })],
    '[data-pick]': [makeEl({ 'data-pick': 'user' }), makeEl({ 'data-pick': 'admin' })],
  };
  const document = {
    querySelector: (s) => single[s] || null,
    querySelectorAll: (s) => multi[s] || [],
    addEventListener() {},
    documentElement: { setAttribute() {} },
  };
  return { single, multi, document };
}

/* ---------------- 云端桩 ---------------- */

function makeCloud(state) {
  return {
    root: '',
    config: { siteOrigin: 'https://ws-blog.app.workbuddy.host' },
    isAdminSync: () => state.admin,
    isAdminMode: () => state.admin && state.identity === 'admin',
    identity: () => state.identity,
    setIdentity: (t) => {
      state.identity = t;
      return Promise.resolve(t !== 'admin' || state.admin);
    },
    currentUser: () => (state.signed ? { email: state.email } : null),
    refresh: () => Promise.resolve(state.signed ? {} : null),
    signInWithPassword: () => {
      state.signed = true;
      return Promise.resolve({ data: {} });
    },
    signOut: () => {
      state.signed = false;
      state.identity = 'user';
      return Promise.resolve();
    },
    booted: () => Promise.resolve(null),
    onSessionChange() {},
    displayName: () => state.email.split('@')[0],
    toast() {},
  };
}

/* ---------------- 跑一个场景 ---------------- */

const src = fs.readFileSync(path.join(root, 'src/scripts/auth.js'), 'utf8');

async function run({ name, admin, search = '' }) {
  const dom = buildDom();
  const state = { admin, identity: 'user', signed: false, email: 'admin@example.com' };

  const location = {
    origin: 'https://ws-blog.app.workbuddy.host',
    search,
    pathname: '/login.html',
    href: 'https://ws-blog.app.workbuddy.host/login.html' + search,
    reload() {},
  };
  const document = Object.assign(dom.document, {
    location,
  });
  const win = { WSBlogCloud: makeCloud(state), __ROOT__: '' };

  /* 隔离 global：auth.js 只通过入参拿到宿主对象 */
  const factory = new Function('window', 'document', 'location', 'URLSearchParams', 'console', src);
  factory(win, document, location, URLSearchParams, console);

  const C = win.WSBlogCloud;
  await C.booted();

  dom.single['[name="email"]'].value = state.email;
  dom.single['[name="password"]'].value = 'secret-password';
  dom.single['[data-auth-form]'].fire('submit');

  await new Promise((r) => setTimeout(r, 20));

  const out = {
    scenario: name,
    formHidden: dom.single['[data-auth-form-wrap]'].hasAttribute('hidden'),
    pickVisible: !dom.single['[data-identity-pick]'].hasAttribute('hidden'),
    pickEmail: dom.single['[data-pick-email]'].textContent,
    identity: state.identity,
    navigatedTo: location.href,
  };
  return { out, dom, state, location, C };
}

const scenarios = [];
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  scenarios.push(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ' (期望 ' + JSON.stringify(expected) + ')'}`);
}

/* 场景 A：普通账号登录 —— 不应出现身份选择 */
{
  const { out } = await run({ name: '普通账号', admin: false });
  check('A 表单不隐藏（直接跳走）', out.formHidden, false);
  check('A 不出现身份选择', out.pickVisible, false);
  check('A 跳转', out.navigatedTo, 'index.html');
}

/* 场景 B：管理员账号登录 —— 出现身份选择，停在登录页 */
{
  const { out } = await run({ name: '管理员账号', admin: true });
  check('B 表单隐藏', out.formHidden, true);
  check('B 出现身份选择', out.pickVisible, true);
  check('B 显示账号邮箱', out.pickEmail, 'admin@example.com');
  check('B 未自动跳转', out.navigatedTo, 'https://ws-blog.app.workbuddy.host/login.html');
}

/* 场景 C：管理员选「以普通用户身份进入」 */
{
  const { dom, state, location } = await run({ name: '管理员→普通用户', admin: true });
  dom.multi['[data-pick]'][0].click();
  await new Promise((r) => setTimeout(r, 20));
  check('C 身份=user', state.identity, 'user');
  check('C 跳转个人中心', location.href, 'account.html');
}

/* 场景 D：管理员选「进入后台管理」 */
{
  const { dom, state, location } = await run({ name: '管理员→后台', admin: true });
  dom.multi['[data-pick]'][1].click();
  await new Promise((r) => setTimeout(r, 20));
  check('D 身份=admin', state.identity, 'admin');
  check('D 跳转后台', location.href, 'admin.html');
}

/* 场景 E：带 next 参数时，普通账号回到来源页 */
{
  const { location } = await run({ name: 'next 回跳', admin: false, search: '?next=/posts.html' });
  check('E 回到来源页', location.href, 'posts.html');
}

/* 场景 F：管理员 + next，选普通用户时优先回来源页 */
{
  const { dom, location } = await run({ name: 'admin+next', admin: true, search: '?next=/posts.html' });
  dom.multi['[data-pick]'][0].click();
  await new Promise((r) => setTimeout(r, 20));
  check('F 回到来源页', location.href, 'posts.html');
}

/* 场景 G：管理员登录后点「退出登录」 */
{
  const { dom, state, location } = await run({ name: '退出', admin: true });
  dom.single['[data-pick-signout]'].click();
  await new Promise((r) => setTimeout(r, 20));
  check('G 会话已清', state.signed, false);
  check('G 身份回落', state.identity, 'user');
  void location;
}

console.log(scenarios.join('\n'));
console.log(failures ? `\n✗ ${failures} 项未通过` : '\n✓ 全部通过');
process.exit(failures ? 1 : 0);
