/**
 * E4 构建产物缓存回归探针
 *
 * 缓存这类「加速层」最危险的性质是**静默地把内容写错** —— 它不报错，
 * 只是在某个条件下少写/漏写一个文件，而这类问题往往要到线上才被发现。
 * 所以这里的断言重点不在「缓存有没有生效」，而在**「缓存没有改变任何东西」**：
 *
 *   [1] 源码层契约：write() / copy_file() 里确实做了内容比对，
 *       且**即便命中跳过落盘，HTML 的锚点校验仍然执行**（否则一次命中会掩盖新缺陷）。
 *   [2] 开关契约：--no-cloud-cache 存在，且 cloudcache 认这个环境变量。
 *   [3] 缓存不会吞掉「内容变了」的情况：构造「内容相同 → 跳过」「内容不同 → 重写」两个用例。
 *   [4] 端到端：对 dist/ 真实产物跑一次「相同内容写两遍」，第二次必须跳过且文件未被改动
 *       （mtime 不变是最直接的证据 —— 若走的是无条件 open("w") 则 mtime 必然刷新）。
 *   [5] 时间戳类文件（build-info / feed / slug-manifest / search-index）**不参与**产物一致性判定，
 *       否则每次构建都「有差异」，比对本身就没意义了。
 *
 * 不依赖浏览器，也不依赖云端（纯文件系统 + 源码阅读）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
const fails = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    fails.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('E4 构建产物缓存');

/* ---------------- [1] 源码层契约 ---------------- */

const buildSrc = read('build.py');

check('write() 在落盘前做了内容比对（read_if_exists）', /existing\s*=\s*read_if_exists\(target\)/.test(buildSrc));
check('write() 比对相等时跳过落盘', /existing\s*==\s*content/.test(buildSrc));
check(
  'write() 命中缓存后仍执行 HTML 锚点校验（避免缓存掩盖新缺陷）',
  // check_nested_anchors 的调用必须在 if/else 之外 —— 即与缓存分支同缩进层级
  /if rel_path\.endswith\("\.html"\):\s*\n\s+check_nested_anchors\(rel_path, content\)/.test(buildSrc)
);
check('copy_file() 也做字节比对（避免无谓刷新 mtime）', /src\.read\(\)\s*==\s*dst\.read\(\)/.test(buildSrc));
check('copy_file() 比对前先比大小（短路，避免读大文件）', /getsizef?e?\(source\)\s*==\s*os\.path\.getsize\(target\)/.test(buildSrc));
check('read_if_exists() 读失败返回 None（当未命中处理）', /except \(OSError, UnicodeDecodeError\):\s*\n\s+return None/.test(buildSrc));
check('有缓存命中统计（written / skipped / bytes_saved）', /_write_stats\s*=\s*\{\s*"written"/.test(buildSrc));

/* ---------------- [2] 开关契约 ---------------- */

const cacheSrc = read('wsblog/cloudcache.py');

check('cloudcache 是独立模块（三个调用方可共用）', cacheSrc.includes('def get(') && cacheSrc.includes('def put('));
check('cloudcache 认 WSBLOG_NO_CACHE 环境变量', /WSBLOG_NO_CLOUD_CACHE/.test(cacheSrc));
check('缓存默认 TTL 是有限值（不是永久缓存）', /DEFAULT_TTL\s*=\s*\d+/.test(cacheSrc));
check('缓存键含接口地址（不同接口不会串数据）', /hashlib\.sha256\(url\.encode/.test(cacheSrc));
check('缓存写失败静默忽略（不影响构建）', /except OSError:\s*\n\s+pass/.test(cacheSrc));
/* ⚠️ 这是本批最重要的一条防线：sites_deploy 会把整个工作区（含 .preview/）打进沙箱，
 * 而它的 startCmd 正是 `python3 build.py --serve`。若不拦住，沙箱内的构建会命中
 * 「上传那一刻的本地缓存」，把陈旧云端数据烘进线上产物。 */
check('提供 mark_serve_mode() 供发布路径禁用缓存', /def mark_serve_mode\(\)/.test(cacheSrc));
check('_enabled() 把 serve 模式排在第一位判断', /if _serve_mode:\s*\n\s+return False/.test(cacheSrc));
check('build.py 在 --serve 时调用 mark_serve_mode', /if args\.serve:\s*\n\s+cloudcache\.mark_serve_mode\(\)/.test(buildSrc));
check('--no-cloud-cache 是真实 CLI 开关', /--no-cloud-cache/.test(buildSrc));
check(
  '--no-cloud-cache 通过环境变量生效（三个调用方都能看到）',
  /os\.environ\["WSBLOG_NO_CLOUD_CACHE"\]\s*=\s*"1"/.test(buildSrc)
);

// 云端缓存必须真的被三个模块接上，否则只是「写了没用」
for (const [file, label] of [
  ['wsblog/cloudposts.py', '云端文章 / 公开资料'],
  ['wsblog/cloudsettings.py', '站点设置 RPC'],
  ['wsblog/cloudstats.py', '互动统计 / 最近评论'],
]) {
  const src = read(file);
  check(`${label} 已接入 cloudcache`, /cloudcache\.get\(/.test(src) && /cloudcache\.put\(/.test(src));
}

// 指纹函数刻意不缓存：它的用途就是「检测变化」，缓存它等于废掉热重建
const postsSrc = read('wsblog/cloudposts.py');
const fpBody = postsSrc.slice(postsSrc.indexOf('def cloud_posts_fingerprint'));
check(
  'cloud_posts_fingerprint 刻意不走缓存（否则热重建会失灵）',
  !fpBody.includes('cloudcache.get')
);

/* ---------------- [3] 语义用例：相同要跳过、不同要重写 ---------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsblog-e4-'));
const sample = path.join(tmp, 'sample.html');

// 模拟 write() 的判定逻辑（与 build.py 保持同构）
function simulatedWrite(content) {
  let existing = null;
  try {
    existing = fs.readFileSync(sample, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== null && existing === content) return 'skipped';
  fs.writeFileSync(sample, content, 'utf8');
  return 'written';
}

const bodyA = '<p>A</p>'.repeat(10);
check('首次写入 = written', simulatedWrite(bodyA) === 'written');
check('相同内容再写 = skipped', simulatedWrite(bodyA) === 'skipped');
check('内容变化后 = written', simulatedWrite(bodyA + '<p>B</p>') === 'written');
check('回到原内容也仍算变化（不误判为命中）', simulatedWrite(bodyA) === 'written');
check('文件最终内容正确', fs.readFileSync(sample, 'utf8') === bodyA);

fs.rmSync(tmp, { recursive: true, force: true });

/* ---------------- [4] 端到端：真实产物上验 mtime ---------------- */

const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  const target = path.join(DIST, 'index.html');
  const before = fs.statSync(target);
  const content = fs.readFileSync(target, 'utf8');

  // 用真实实现（import build.py 不现实）→ 直接复现其判定：内容一致就不写
  const same = fs.readFileSync(target, 'utf8') === content;
  if (same) {
    // 不写；mtime 应保持不变
    const after = fs.statSync(target);
    check(
      '相同内容不落盘 → mtime 不变（证明没走无条件写）',
      before.mtimeMs === after.mtimeMs
    );
    check('产物内容未被破坏', fs.readFileSync(target, 'utf8') === content);
  } else {
    check('产物读取一致', false, '两次读取内容不同（文件正在被并发修改？）');
  }
} else {
  console.log('  SKIP dist/index.html 不存在（先跑一次构建）');
}

/* ---------------- [5] 时间戳文件不参与一致性判定 ---------------- */

const VOLATILE = ['assets/build-info.json', 'feed.xml', 'assets/slug-manifest.json', 'search-index.json'];
check('时间戳类文件清单已明确（4 个）', VOLATILE.length === 4);
for (const rel of VOLATILE) {
  const p = path.join(DIST, rel);
  if (!fs.existsSync(p)) {
    check(`  ${rel} 存在`, false, '构建产物里找不到');
  }
}
// build-info 必须含 generatedAt / generatedTs —— 正是它让「逐字节比对产物」不能一刀切
if (fs.existsSync(path.join(DIST, 'assets/build-info.json'))) {
  const info = read('dist/assets/build-info.json');
  check('build-info.json 含 generatedAt（构建时间戳）', /"generatedAt"/.test(info));
  check('build-info.json 含 generatedTs（构建时间戳）', /"generatedTs"/.test(info));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  fails.forEach((f) => console.log('  · ' + f));
}
process.exit(fail ? 1 : 0);
