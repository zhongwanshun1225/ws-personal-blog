/* 自动备份面板回归（B5 的后台 UI）
 *
 * 只在 dist/ 产物上做静态断言 —— 面板的真实数据要登录管理员才能看到，
 * 本地 127.0.0.1 上云端功能一律 403（Origin 白名单），所以这里只保证
 * 「结构在、脚本挂上了、关键提示没丢」，交互留待线上手测。
 *
 * 跑法：node tests/backup-panel-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

const adminHtml = fs.readFileSync(path.join(DIST, 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(DIST, 'assets', 'admin.js'), 'utf8');
const css = fs.readFileSync(path.join(DIST, 'assets', 'main.css'), 'utf8');

console.log('\n[1] 面板 DOM 在产物里');
check('admin.html 有「自动备份」标题', adminHtml.includes('自动备份'));
check('有状态容器 data-backup-state', adminHtml.includes('data-backup-state'));
check('有刷新按钮 data-backup-refresh', adminHtml.includes('data-backup-refresh'));
check('有保存按钮 data-backup-save', adminHtml.includes('data-backup-save'));

console.log('\n[2] 五个策略控件齐备');
['data-backup-enabled', 'data-backup-hour', 'data-backup-kind',
 'data-backup-keep', 'data-backup-offsite'].forEach((attr) => {
  check('控件 ' + attr, adminHtml.includes(attr));
});
check('异地留存有 off / webhook / s3 三档',
  adminHtml.includes('value="off"') && adminHtml.includes('value="webhook"') &&
  adminHtml.includes('value="s3"'));

console.log('\n[3] JS 挂载与 RPC');
check('admin.js 定义了 loadBackupPanel', /function loadBackupPanel/.test(adminJs));
check('切到 data 分区时加载', /name === 'data'\)\s*loadBackupPanel\(\)/.test(adminJs));
check('调用 admin_backup_status', adminJs.includes('admin_backup_status'));
check('调用 admin_backup_setting', adminJs.includes('admin_backup_setting'));
check('保存时按 key 逐条提交（后端是单键白名单）',
  /p_key: key, p_value: val/.test(adminJs));

console.log('\n[4] 三态映射完整');
['ok:', 'ok_offsite_failed:', 'failed:'].forEach((k) => {
  check('状态表含 ' + k.replace(':', ''), new RegExp(k.replace(':', '\\s*:\\s*\\{')).test(adminJs));
});
check('有「未启用异地」的显式告警', adminJs.includes('未启用异地留存'));

console.log('\n[5] 样式在产物 CSS 里');
['.backup-state', '.backup-state__badge--ok', '.backup-state__badge--warn',
 '.backup-state__badge--bad', '.backup-state__alert', '.field--inline'].forEach((sel) => {
  check('CSS 含 ' + sel, css.includes(sel));
});
check('没有引用不存在的 --ok / --line 变量',
  !/var\(--ok\)/.test(css) && !/var\(--line\)/.test(css));

console.log('\n' + '─'.repeat(52));
console.log(`  备份面板回归：${pass} 通过 / ${fail} 失败`);
if (fail) console.log('  失败项：' + failures.join(' | '));
console.log('─'.repeat(52) + '\n');
process.exit(fail ? 1 : 0);
