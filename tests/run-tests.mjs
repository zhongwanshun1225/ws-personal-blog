#!/usr/bin/env node
/**
 * 统一回归入口：一次跑完 `tests/` 下所有探针，任一失败即整体失败（退出码 1）。
 *
 * 为什么要有它：CI 里一条 `run:` 就能覆盖全部断言，不用在 workflow 里罗列文件
 * （加新探针时也不必改 workflow）。本地开发同样一条命令即可自检。
 *
 * 设计要点：
 *   · 每个探针独立子进程 —— 一个崩了不影响其余，失败详情仍完整打印。
 *   · 探针自带静态服务（见 tests/_serve.mjs），不再依赖外部先跑 `build.py --serve`。
 *   · 依赖浏览器的断言由探针内部探测后自行 SKIP（不动退出码），
 *     所以 CI 上没有 Chrome 也照样能跑完，不会把环境缺失误报成回归。
 *   · **必须先构建**：这些断言大多读 dist/ 产物。脚本会自己检查 dist/index.html 是否存在。
 *
 * 用法：
 *   node tests/run-tests.mjs             # 跑全部
 *   node tests/run-tests.mjs idle batch6 # 只跑名字含这些子串的
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* 探针清单（顺序即执行顺序：先纯逻辑，后需要产物/服务的）。 */
const SUITES = [
  'idle-test.mjs',
  'auth-flow-test.mjs',
  'comment-thread-test.mjs',
  'mirror-redirect-test.mjs',
  /* 云函数离线自测：只读源码 + 用官方测试向量验 SigV4，不依赖 dist/ 也不依赖浏览器。
   * 放在这里是因为它覆盖的「三态判定 / 签名派生」都是写错了也不会报错的静默 bug。 */
  'ws-backup-test.mjs',
  'backup-panel-test.mjs',
  /* E4 构建缓存：纯文件系统 + 源码契约，不需要浏览器。
   * 放这里的理由是它的失败模式极隐蔽 —— 缓存写错不会报错，只会少写文件。 */
  'build-cache-test.mjs',
  /* Chrome 噪音过滤：纯字符串样本，不需要浏览器 —— 这正是要点。
   * 2026-10-19 CI 连挂三次，就是因为这条规则的缺陷只在有 Chrome 的机器上暴露，
   * 本地恒 SKIP。用构造样本把它钉死，两侧都测（滤得干净 + 不漏真错）。 */
  'chrome-noise-test.mjs',
  'batch3-smoke.mjs',
  'batch3-notify-render.mjs',
  'batch4-smoke.mjs',
  'batch6-smoke.mjs',
  'batch7-smoke.mjs',
  'guest-smoke.mjs',
];

const filters = process.argv.slice(2);
const picked = filters.length ? SUITES.filter((f) => filters.some((k) => f.includes(k))) : SUITES;

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ 找不到 dist/index.html —— 先跑 `python build.py --clean` 再执行探针。');
  process.exit(1);
}
if (!picked.length) {
  console.error('✗ 没有匹配的探针：' + filters.join(' '));
  process.exit(1);
}

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, file)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code: code || 0, out }));
    p.on('error', (e) => resolve({ code: 1, out: 'spawn 失败：' + e.message }));
  });
}

const results = [];
for (const file of picked) {
  process.stdout.write(`\n${'─'.repeat(64)}\n▶ ${file}\n`);
  const { code, out } = await run(file);
  // 逐行转发，CI 日志里能直接看到 PASS/FAIL 明细
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  // 从输出里摘一行摘要（各探针措辞不同，尽量都认）
  const summary = out.split('\n').reverse()
    .find((l) => /通过 \/|passed,|全部通过|\/\d+ 通过|SKIP/.test(l)) || '';
  results.push({ file, code, summary: summary.trim() });
}

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(64));
console.log('回归汇总');
console.log('-'.repeat(64));
let failed = 0;
for (const r of results) {
  const tag = r.code === 0 ? 'OK  ' : 'FAIL';
  if (r.code !== 0) failed++;
  console.log(`${tag}  ${r.file.padEnd(26)} ${r.summary}`);
}
console.log('-'.repeat(64));
console.log(failed ? `✗ ${failed}/${results.length} 个探针失败` : `✓ 全部 ${results.length} 个探针通过`);
process.exit(failed ? 1 : 0);
