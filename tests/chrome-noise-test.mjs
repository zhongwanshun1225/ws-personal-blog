/**
 * 回归：`_serve.mjs::filterPageErrors` 的噪音过滤规则。
 *
 * 为什么值得单独立一个探针：
 * 2026-10-19 CI 连续三次 `Deploy to GitHub Pages` 失败，卡在 **Smoke tests** 一步 ——
 * batch4 / batch6 的「无未捕获异常」断言把 Chrome 自己的进程日志当成了页面报错：
 *   [2755:2776:…:ERROR:dbus/bus.cc:405] Failed to connect to the bus: …
 * 这是 headless 容器缺 D-Bus 的固有噪音，与站点毫无关系。
 *
 * 更贵的是它的**失败模式**：本地沙箱起不了 Chrome → 这条断言恒 SKIP → 本地永远全绿，
 * 只有跑到 CI 才炸。所以必须在这里用**构造样本**把规则钉死，不再依赖有没有浏览器。
 *
 * 两侧都要测：
 *   · 滤得干净 —— Chrome 进程日志（dbus / GPU / sandbox / GCM / updater）一条都不能留；
 *   · 不漏真错 —— 页面 JS 抛的 Uncaught / console 报错必须全部保留。
 * 只测一边的话，「过滤过宽」会让这条护栏彻底失效（永远绿），是比红更糟的结局。
 */
import { filterPageErrors } from './_serve.mjs';

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

/* Chrome 自身进程日志：形态是 `[pid:tid:MMDD/HHMMSS.micro:LEVEL:file:line] 正文`。
 * 覆盖实际见过的几类（CI 日志里真实出现过前两类；其余是最常见同族噪音）。 */
const CHROME_NOISE = [
  '[2755:2776:1015/153541.545689:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type',
  '[2912:2933:1015/153543.619464:ERROR:dbus/bus.cc:405] Failed to connect to the bus',
  '[3030:3040:1015/153540.123456:ERROR:gpu_memory_buffer_support_x11.cc:50] Failed to create GLES3 context',
  '[3381:3402:1015/153603.527489:SEVERE:gcm/engine.cc:1234] GCM chrome cert failed to verify',
  '[3381:3402:1015/153603.527489:ERROR:sandbox_linux.cc:45] InitializeSandbox() called with multiple threads',
  '[3381:3402:1015/153603.527489:WARNING:updater.cc:99] Failed to update',
];

/* 真实的页面级报错：两种形态都要留住。
 * ① console 型带时间戳但**没有 pid:tid**，方括号内是 CONSOLE(行号)；
 * ② 裸 Uncaught（无前缀）。 */
const PAGE_ERRORS = [
  '[1015/153541.545689:ERROR:CONSOLE(42)] "Uncaught TypeError: Cannot read properties of null (reading \'foo\')", source: http://127.0.0.1:4199/assets/app.js (42)',
  'Uncaught ReferenceError: WSBlogCloud is not defined',
  '[1015/153542.000000:INFO:CONSOLE(7)] "SyntaxError: Unexpected token \'<\'", source: http://127.0.0.1:4199/assets/x.js (7)',
];

console.log('— 过滤干净：Chrome 进程日志一律不留 —');
const noiseOut = filterPageErrors(CHROME_NOISE.join('\n'));
check('全部滤除后为空', noiseOut.trim() === '', `残留 ${noiseOut.split('\n').filter(Boolean).length} 行`);
for (const line of CHROME_NOISE) {
  const one = filterPageErrors(line);
  check(`滤除 ${line.split(':')[4] || 'unknown'}`, one.trim() === '', one.slice(0, 80));
}

console.log('— 不漏真错：页面 JS 报错一律保留 —');
const errOut = filterPageErrors(PAGE_ERRORS.join('\n'));
const keptLines = errOut.split('\n').filter(Boolean);
check(`保留全部 ${PAGE_ERRORS.length} 条`, keptLines.length === PAGE_ERRORS.length,
  `实际保留 ${keptLines.length} 条`);
check('保留 Uncaught TypeError', errOut.includes('Cannot read properties of null'));
check('保留裸 Uncaught ReferenceError', errOut.includes('WSBlogCloud is not defined'));
check('保留 CONSOLE 里的 SyntaxError', errOut.includes('Unexpected token'));

console.log('— 混合样本：噪声滤除、真错保留 —');
const mixed = filterPageErrors([...CHROME_NOISE, ...PAGE_ERRORS].join('\n'));
const mixedLines = mixed.split('\n').filter(Boolean);
check('只留页面错误', mixedLines.length === PAGE_ERRORS.length, `实际 ${mixedLines.length} 条`);
check('不含 dbus 噪音', !mixed.includes('dbus/bus.cc'));
check('不含 gcm / sandbox 噪音', !mixed.includes('gcm/engine.cc') && !mixed.includes('sandbox_linux.cc'));

console.log('— 既有豁免仍然生效 —');
check('403 资源加载失败豁免', filterPageErrors('Failed to load resource: the server responded with a status of 403').trim() === '');
check('net::ERR 豁免', filterPageErrors('net::ERR_CONNECTION_REFUSED').trim() === '');
check('扩展告警豁免', filterPageErrors('Extension error: something').trim() === '');
check('load_error_reporter 豁免', filterPageErrors('load_error_reporter: ERROR').trim() === '');

console.log('— 空输入不炸 —');
check('空串', filterPageErrors('') === '');
check('纯换行', filterPageErrors('\n\n').trim() === '');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
