/* 第三批（通知 / 分页 / 草稿）静态与逻辑冒烟。
 * 覆盖：三类页面 HTTP 200 + 关键 DOM 标记、draft.js 本地草稿原语与自动保存接线。
 */
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { startStaticServer } from './_serve.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const srv = await startStaticServer(4199);
const BASE = srv.base;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function fetchText(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }));
    }).on('error', reject);
  });
}

console.log('— HTTP 资源 —');
for (const [p, expect] of [
  ['/notifications.html', 200],
  ['/admin.html', 200],
  ['/write.html', 200],
  ['/posts.html', 200],
  ['/assets/notify.js', 200],
  ['/assets/notifications.js', 200],
  ['/assets/draft.js', 200],
]) {
  const r = await fetchText(p);
  check(`${p} → ${expect}`, r.status === expect, `got ${r.status}`);
}

console.log('— 通知中心页面 —');
{
  const { body } = await fetchText('/notifications.html');
  for (const marker of [
    'data-notify-page', 'data-notify-list', 'data-notify-more', 'data-notify-read-all',
    'data-notify-clear', 'data-notify-filter="all"', 'data-notify-filter="unread"',
    'data-notify-unread-chip', 'data-notify-summary', 'data-notify-gate',
  ]) {
    check(`含 ${marker}`, body.includes(marker));
  }
  check('注入 notifications.js', body.includes('assets/notifications.js'));
  check('注入 notify.js', body.includes('assets/notify.js'));
  check('含通知铃铛插槽', body.includes('data-notify-slot'));
  check('og:type 仅一处', (body.match(/property="og:type"/g) || []).length === 1);
}

console.log('— 后台页面（分页 / 搜索 / 草稿） —');
{
  const { body } = await fetchText('/admin.html');
  for (const marker of [
    'data-post-search', 'data-post-status', 'data-post-pager',
    'data-comment-search', 'data-comment-pager', 'data-comment-filter="hidden"',
    'data-user-search', 'data-user-status', 'data-user-pager',
    'data-review-pager', 'data-reviewed-pager',
    'data-admin-draft-banner', 'data-admin-draft-restore', 'data-admin-draft-discard',
    'data-admin-status',
  ]) {
    check(`含 ${marker}`, body.includes(marker));
  }
  check('注入 draft.js', body.includes('assets/draft.js'));
  check('文章列表提示语已改为可筛选文案', !body.includes('用左边的编辑器写下第一篇。</td>'));
}

console.log('— 投稿页（草稿自动保存） —');
{
  const { body } = await fetchText('/write.html');
  check('含本地草稿横幅', body.includes('data-draft-banner'));
  check('含恢复按钮', body.includes('data-draft-restore'));
  check('含丢弃按钮', body.includes('data-draft-discard'));
  check('含自动保存状态位', body.includes('data-write-status'));
  check('投稿须知已提到自动保存', body.includes('自动保存在本机'));
  check('注入 draft.js', body.includes('assets/draft.js'));
}

console.log('— draft.js 逻辑（vm 沙箱） —');
{
  const code = fs.readFileSync(path.join(ROOT, 'src/scripts/draft.js'), 'utf8');
  const store = new Map();
  const listeners = {};
  const sandbox = {
    console,
    Date,
    JSON,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    window: {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      clearInterval: () => {},
    },
    document: { addEventListener: () => {}, visibilityState: 'visible' },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const D = sandbox.window.WSBlogDraft;
  check('暴露 WSBlogDraft', !!D);

  const key = D.key('write', 'demo');
  check('key 命名规范', key === 'wsblog:draft:v2:write:demo', key);

  D.write(key, { title: '标题', content_md: '正文' });
  const back = D.read(key);
  check('写入后可读回', !!back && back.title === '标题');

  D.write(key, { title: 'x' });
  store.set(key, JSON.stringify({
    title: 'x',
    savedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(),
  }));
  check('超过 30 天的草稿被清理', D.read(key) === null);

  store.set(key, '{ 坏掉的 json');
  check('损坏的 json 被清理', D.read(key) === null && !store.has(key));

  /* attach：模拟表单输入 → 防抖落盘 → markSaved 清理 */
  const handlers = {};
  const form = { addEventListener: (t, fn) => { handlers[t] = fn; } };
  let statusText = '';
  const ctrl = D.attach({
    form,
    keyFn: () => D.key('write', 'attach-demo'),
    collect: () => ({ title: '自动', content_md: '内容' }),
    isEmpty: (d) => !String(d.title || '').trim(),
    onStatus: (t) => { statusText = t; },
  });
  check('attach 返回控制器', !!ctrl);
  handlers.input();
  await new Promise((r) => setTimeout(r, 1500));
  check('输入后自动落盘', !!D.read(D.key('write', 'attach-demo')));
  check('状态文案已回显', /已自动保存/.test(statusText), statusText);
  ctrl.markSaved('已保存到云端');
  check('markSaved 清掉本地草稿', D.read(D.key('write', 'attach-demo')) === null);
  check('markSaved 更新状态', statusText === '已保存到云端', statusText);
}

await srv.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
