/* dist 探针残留检查
 *
 * 为什么需要这条：`tests/batch3-notify-render.mjs` 要往 dist/ 写一个探针页
 * （为了让探针和站点共用同一套相对路径与脚本）。但 dist/ 是**发布产物** ——
 * `sites_deploy` 打包整个工作区、`git` 也不管 dist，唯一能拦住它泄漏上线的
 * 只有探针自己的清理逻辑。
 *
 * 2026-10-19 实拍：线上产物里躺着 `__probe_notify.html`。原因是 SKIP 分支
 * （本沙箱起不了 Chrome）在写文件之后直接 `process.exit(0)` 就走了，
 * 清理代码根本没执行到。也就是说**越是本地跑，越会留下垃圾**，而本地跑得最多。
 *
 * 这条断言不依赖浏览器，只看文件系统：跑完全套探针后 dist/ 里不该有 `__probe*`。
 * 它拦的是「以后谁又加了一个提前 return」这类回归，而不是某个具体实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/* dist 不存在说明还没构建，这时断言无从谈起 —— 跳过而不是假红。 */
if (!fs.existsSync(DIST)) {
  console.log('  SKIP dist 不存在（先跑 python build.py）');
  console.log('\n结果：0 通过 / 0 失败（跳过）');
  process.exit(0);
}

const leaked = fs.readdirSync(DIST).filter((n) => /^__?probe/i.test(n));

check(
  'dist/ 里没有探针残留文件',
  leaked.length === 0,
  leaked.length ? '残留：' + leaked.join(', ') + '（会随发布带上线）' : ''
);

/* 反向断言：探针源文件里必须存在清理登记。
 * 只测「现在没残留」是不够的 —— 一次干净的运行本来就没残留，
 * 得确认「清理机制本身还在」，否则下次 SKIP 又会漏。 */
const probeSrc = path.join(ROOT, 'tests', 'batch3-notify-render.mjs');
let src = '';
try {
  src = fs.readFileSync(probeSrc, 'utf8');
} catch (e) {
  src = '';
}

check('batch3-notify-render.mjs 存在', src.length > 0);
check(
  '探针注册了 exit 清理（process.on("exit", …)）',
  /process\.on\(\s*['"]exit['"]/.test(src),
  '否则 SKIP 分支提前退出时会留下 dist/__probe_notify.html'
);
check(
  '清理逻辑覆盖 unlink',
  /unlinkSync|unlink\(/.test(src),
  '清理函数得真的删文件'
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
