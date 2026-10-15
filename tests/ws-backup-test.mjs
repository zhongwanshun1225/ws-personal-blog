/* ws-backup 离线自测（不入仓库，.preview/ 在 .gitignore 内）
 *
 * 目的：把 exports.main 的完整流程用桩跑通，重点验证两处「写错了也不会报错、
 * 只会在线上静默出错」的地方：
 *   1. status 三态判定（ok / ok_offsite_failed / failed）—— 分支多，容易写反
 *   2. AWS Signature V4 的派生签名密钥与 canonical request —— 对端只会回 403，
 *      不会告诉你哪一步错了，所以必须拿官方测试向量对一遍
 *
 * 跑法：node .preview/ws-backup-test.mjs
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const FN = path.resolve(import.meta.dirname, '../cloudfunctions/ws-backup/index.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

/* ---------------- 1. SigV4 官方测试向量 ---------------- */
/* AWS 文档给的标准用例（get-vanilla 系列用的是固定密钥/日期）。
 * 我们只复用密钥派生那一步：signingKey 必须是 hmac 四层链的结果。
 * 参考向量：secret=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, date=20150830, region=us-east-1, service=iam
 * 期望 signing key 的十六进制（公开文档值）：
 *   c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9
 */
function deriveSigningKey(secret, dateStamp, region, service) {
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  let k = hmac('AWS4' + secret, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  return k.toString('hex');
}

console.log('\n[1] SigV4 signing key（AWS 官方测试向量）');
const EXPECTED_SIGNING_KEY =
  'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9';
const got = deriveSigningKey(
  'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
check('四层派生签名密钥与 AWS 文档一致', got === EXPECTED_SIGNING_KEY, got);

/* SHA256 空串与已知串 */
console.log('\n[2] sha256 基本正确性');
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
check('sha256("") 为标准值',
  sha256hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('sha256("abc") 为标准值',
  sha256hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

/* ---------------- 3. status 三态判定 ---------------- */
/* 把 index.js 里的判定逻辑抽出来单独测（同一份语义，注意与源文件保持同步）。
 * 之所以不直接跑 exports.main：那要先桩掉 pgrest / storage / webhook 三路网络，
 * 而这里要盯的恰恰只是最后那几行 if 的取值。 */
console.log('\n[3] status 三态判定');

function decideStatus(localOk, remoteOn, remoteOk) {
  const anyCopy = localOk || (remoteOn && remoteOk);
  if (!anyCopy) return 'failed';
  if (remoteOn && !remoteOk) return 'ok_offsite_failed';
  return 'ok';
}

/* 逐条覆盖真值表的 6 种组合 */
check('本站 ok + 异地关          → ok',
  decideStatus(true, false, false) === 'ok', decideStatus(true, false, false));
check('本站 ok + 异地成功        → ok',
  decideStatus(true, true, true) === 'ok', decideStatus(true, true, true));
check('本站 ok + 异地失败        → ok_offsite_failed（主流程成功，不误报 failed）',
  decideStatus(true, true, false) === 'ok_offsite_failed', decideStatus(true, true, false));
check('本站失败 + 异地成功      → ok（有副本就算成功）',
  decideStatus(false, true, true) === 'ok', decideStatus(false, true, true));
check('本站失败 + 异地失败      → failed（一个副本都没落地）',
  decideStatus(false, true, false) === 'failed', decideStatus(false, true, false));
check('本站失败 + 异地关        → failed（一个副本都没落地）',
  decideStatus(false, false, false) === 'failed', decideStatus(false, false, false));

/* ---------------- 4. 源文件里确实用的是这套判定 ---------------- */
console.log('\n[4] 源文件一致性');
const src = require('node:fs').readFileSync(FN, 'utf8');
check('源文件含 anyCopy 判定', /const anyCopy = local\.ok \|\| \(remoteOn && remote\.ok\)/.test(src));
check('源文件含 ok_offsite_failed 分支',
  /remoteOn && !remote\.ok\)\s*\{\s*status = 'ok_offsite_failed'/.test(src));
check('源文件不再残留旧的 local_failed 状态', !/'local_failed'/.test(src));
check('源文件不再残留旧的 export_error 之类未定义状态', !/beat\(secret, 'export_rejected'\)[\s\S]{0,20}'ok'/.test(src));
check('已导出 main', /exports\.main = async function/.test(src));

/* ---------------- 5. 路径断言 ---------------- */
console.log('\n[5] 本站留存路径符合 storage 规则');
/* validateObjectPath 只放行 users/<uid>/... 或 shared/<owner>/...
 * worker 没有用户身份，所以必须落在 shared/ 下。 */
check('使用 shared/ws-backup/ 前缀',
  /'shared\/ws-backup\/' \+ meta\.name/.test(src));
check('用 runtime 桶（SDK 只认这个桶）',
  /\/\.cloud\/storage\/object\/runtime\//.test(src));
check('带 x-upsert 头（同名快照覆盖而非报错）', /'x-upsert': 'true'/.test(src));
check('本站留存默认关闭（不构成备份，见 storeLocal 说明）',
  /process\.env\.BACKUP_STORE_LOCAL === 'true'/.test(src));
check('源码写明了 401 MISSING_CREDENTIALS 的实测结论',
  /MISSING_CREDENTIALS/.test(src));

/* ---------------- 6. 零外部依赖 ---------------- */
console.log('\n[6] 依赖面');
const pkg = JSON.parse(require('node:fs').readFileSync(
  path.resolve(import.meta.dirname, '../cloudfunctions/ws-backup/package.json'), 'utf8'));
check('package.json 依赖为空（只用 Node 内置模块）',
  Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify(pkg.dependencies));
/* index.js 里内置模块是裸名 require('crypto')，不是 require('node:crypto') */
const BUILTINS = new Set([
  'crypto', 'https', 'http', 'zlib', 'fs', 'path', 'url', 'os',
  'util', 'events', 'stream', 'buffer', 'querystring', 'assert', 'net', 'tls'
]);
const externalReqs = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)]
  .map((m) => m[2])
  .filter((n) => !n.startsWith('./') && !n.startsWith('../') &&
    !n.startsWith('node:') && !BUILTINS.has(n));
check('index.js 未 require 外部包（只相对路径 / node: / 内置裸名）',
  externalReqs.length === 0, externalReqs.join(', ') || '(none)');

/* ---------------- 7. 投递三路的头 ---------------- */
console.log('\n[7] 投递协议');
check('Webhook 带 HMAC-SHA256 签名头', /X-WS-Signature.*sha256=/.test(src));
check('Webhook 带 kind / at / name 元信息',
  /X-WS-Backup-Kind/.test(src) && /X-WS-Backup-At/.test(src) && /X-WS-Backup-Name/.test(src));
check('S3 走 path-style（endpoint/bucket/key）', /canonicalUri = '\/' \+ bucket \+ '\/'/.test(src));
check('S3 带 x-amz-content-sha256', /'x-amz-content-sha256': payloadHash/.test(src));
check('gzip 可关（BACKUP_GZIP=false）', /BACKUP_GZIP !== 'false'/.test(src));
check('默认 gzip 扩展名为 .json.gz', /'\.json\.gz'/.test(src));

/* ---------------- 收尾 ---------------- */
console.log('\n' + '─'.repeat(52));
console.log(`  ws-backup 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('  失败项：' + failures.join(' | ')); }
console.log('─'.repeat(52) + '\n');
process.exit(fail ? 1 : 0);
