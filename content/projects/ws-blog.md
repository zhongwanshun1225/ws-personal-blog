---
title: WS Blog
description: 你现在看到的这个站点。Markdown 驱动的静态博客生成器，两个依赖、零运行时框架，构建产物完全自包含。
date: 2026-10-08
stack: [Node.js, marked, highlight.js, 原生 CSS]
tags: [开源, 静态站点]
status: 活跃
featured: true
order: 1
repo: https://github.com/your-github/ws-blog
demo: ""
---

## 它解决什么问题

大多数博客框架要么太重（Next.js + MDX 全家桶），要么改起来处处受限。我想要的是一个**能完整读完源码、想改哪里就改哪里**的方案。

于是有了这个生成器：核心逻辑不到 400 行，没有任何前端框架。

## 关键实现

### 构建时语法高亮

高亮在 Node 侧用 `highlight.js` 完成，输出的 HTML 里已经带了 `<span class="hljs-*">`。好处是页面不需要加载高亮脚本，也不会出现"代码先黑后彩"的闪烁。

```js
import hljs from 'highlight.js';

function highlight(code, lang) {
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  }
  return hljs.highlightAuto(code).value;
}
```

### 零依赖的 front-matter 解析

用 60 行代码实现了博客场景够用的 YAML 子集，省掉了 `gray-matter` 及其依赖树。

### 构建时生成搜索索引

所有文章的纯文本会被抽出来生成 `search-index.json`，前端用加权子串匹配打分，支持 `Ctrl + K` 唤起。

## 技术选型对比

| 维度 | 本方案 | Hexo | VitePress |
| --- | --- | --- | --- |
| 运行时依赖 | 0 | 0 | Vue |
| 依赖总数 | 2 | 200+ | 100+ |
| 构建速度（50 篇） | ~400ms | ~3s | ~5s |
| 改造成本 | 极低 | 中 | 中高 |
| 搜索 | 内置轻量实现 | 需插件 | 内置 |

## 使用方式

```bash
npm install
npm run dev      # 本地预览，改文件自动重建
npm run new post "文章标题"
npm run build    # 产出 dist/
```

## 后续计划

- [x] 标签筛选与标签归档页
- [x] RSS 与 sitemap
- [x] 站内搜索
- [ ] 图片自动压缩（AVIF/WebP 转换）
- [ ] 多语言支持
