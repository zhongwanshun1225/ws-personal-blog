---
title: PicSqueeze
description: 一个命令行图片批量压缩工具。拖一个文件夹进去，自动输出尺寸合适、格式现代的图片，并生成一份压缩报告。
date: 2026-08-15
stack: [Node.js, sharp, CLI]
tags: [工具, 图像处理]
status: 活跃
featured: true
order: 2
repo: https://github.com/your-github/picsqueeze
demo: ""
---

## 起因

给博客配图时，最烦的不是写文章，是**手动压缩图片**：改尺寸、转格式、比对体积，一遍下来十分钟。

于是写了个 CLI，把这一套流程固化下来。

## 用法

```bash
# 压缩整个目录，默认输出到 ./optimized
picsqueeze ./photos

# 指定宽度上限和输出格式
picsqueeze ./photos --max-width 1600 --format avif --quality 72

# 只报告不写入（先看看能省多少）
picsqueeze ./photos --dry-run
```

## 输出示例

```text
✔ 扫描到 42 张图片

  hero-banner.jpg      2.4 MB  →   186 KB   -92.4%   (jpg → avif)
  screenshot-01.png    890 KB  →   142 KB   -84.0%   (png → avif)
  avatar.png           124 KB  →    38 KB   -69.4%   (png → webp)

────────────────────────────────────────────────
  合计  38.2 MB  →  4.7 MB     节省 87.6%
  用时 12.4s（6 并发）
```

## 实现要点

### 用 sharp 而不是 ImageMagick

`sharp` 底层是 libvips，流式处理 + 内置并发，速度比 fork `convert` 快一个数量级：

```js
import sharp from 'sharp';

await sharp(input)
  .resize({ width: maxWidth, withoutEnlargement: true })
  .avif({ quality: 72, effort: 4 })
  .toFile(output);
```

`withoutEnlargement: true` 很关键——否则小图会被拉伸放大，白白增加体积。

### 并发控制

一次性丢 200 个 `sharp` 任务是内存杀手。用一个极简的信号量限制并发数：

```js
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
```

### 智能跳过

已经比原图小的、尺寸已经符合要求的，直接跳过，避免"压了三次反而糊了"：

```js
if (meta.width <= maxWidth && outputSize >= inputSize * 0.95) {
  return { skipped: true, reason: 'already-optimized' };
}
```

## 踩过的坑

> [!WARNING]
> AVIF 的编码速度明显慢于 WebP（同参数下大约慢 3~5 倍）。所以在 `--dry-run` 模式下我默认只估算 WebP 的体积，想看 AVIF 结果需要显式加 `--precise`。

- **EXIF 方向**：手机拍的照片带 Orientation 标记，不调 `.rotate()` 会横过来；
- **透明通道**：转 JPEG 前必须先处理 alpha，否则透明区域会变黑；
- **Windows 长路径**：递归时超过 260 字符会报错，需要加 `\\?\` 前缀。

## 下一步

- [ ] 支持从剪贴板读取截图
- [ ] 生成 HTML `<picture>` 标签片段
- [ ] 集成进构建流程，作为博客的图片预处理步骤
