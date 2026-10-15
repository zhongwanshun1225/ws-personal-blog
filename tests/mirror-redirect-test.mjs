/**
 * 校验 layout.py 生成的镜像跳转脚本：抽出 dist/index.html 里的那段内联脚本，
 * 在模拟的 location 上跑，检查各种主机名 / 路径下的跳转目标。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('dist/index.html', 'utf8');
const m = html.match(/<script>\(function\(\)\{[\s\S]*?mirror=off[\s\S]*?\}\)\(\);<\/script>/);
if (!m) {
  console.error('未能在 dist/index.html 中找到跳转脚本');
  process.exit(1);
}
const code = m[0].replace(/^<script>/, '').replace(/<\/script>$/, '');

const HOST = 'https://ws-blog.app.workbuddy.host';

const cases = [
  // 镜像域名：命中 → 跳到正式域名同路径
  ['zhongwanshun1225.github.io', '/ws-personal-blog/', '', '', HOST + '/'],
  ['zhongwanshun1225.github.io', '/ws-personal-blog/index.html', '', '', HOST + '/index.html'],
  ['zhongwanshun1225.github.io', '/ws-personal-blog/posts/hello.html', '?a=1', '#top', HOST + '/posts/hello.html?a=1#top'],
  ['zhongwanshun1225.github.io', '/ws-personal-blog', '', '', HOST + '/'],
  ['zhongwanshun1225.github.io', '/ws-personal-blog/tags/css.html', '', '', HOST + '/tags/css.html'],
  // 裸 github.io（用户站/组织站形态）同样命中
  ['github.io', '/ws-personal-blog/', '', '', HOST + '/'],
  // 正式域名 / 其他域名：不跳
  ['ws-blog.app.workbuddy.host', '/', '', '', null],
  ['ws-blog.app.workbuddy.host', '/posts/hello.html', '', '', null],
  ['example.com', '/ws-personal-blog/', '', '', null],
  ['notgithub.io', '/ws-personal-blog/', '', '', null],
  // 逃生舱：?mirror=off 停留原处
  ['zhongwanshun1225.github.io', '/ws-personal-blog/', '?mirror=off', '', null],
  ['zhongwanshun1225.github.io', '/ws-personal-blog/', '?a=1&mirror=off', '', null],
  ['zhongwanshun1225.github.io', '/ws-personal-blog/', '?mirror=off&b=2', '', null],
];

let pass = 0;
for (const [hostname, pathname, search, hash, expected] of cases) {
  let result = null;
  const location = { hostname, pathname, search, hash, replace(u) { result = u; } };
  vm.runInNewContext(code, { location });
  const ok = result === expected;
  if (ok) pass += 1;
  const shown = `${hostname}${pathname}${search}`;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${shown.padEnd(52)} -> ${result ?? '(不跳转)'}` +
      (ok ? '' : `   期望 ${expected ?? '(不跳转)'}`)
  );
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
