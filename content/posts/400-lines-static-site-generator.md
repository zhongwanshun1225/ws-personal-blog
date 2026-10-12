---
title: 用 400 行代码写一个静态站点生成器
date: 2026-10-08
tags: [Node.js, 静态站点, 工程化]
summary: 不引入 Next.js、不用 Hexo，从零实现一个 Markdown 驱动的博客生成器：front-matter 解析、构建时语法高亮、搜索索引与 RSS 一次性产出自包含的静态文件。
pinned: true
draft: false
---

## 为什么要自己写

博客这件事，最容易犯的错误是**把时间花在选型上，而不是写作上**。Hexo、Hugo、VitePress、Astro 都能用，但在动手前我给自己列了三条硬约束：

1. 新增文章**只需丢一个 `.md` 文件**，不改任何代码；
2. 构建产物是**纯静态 HTML**，不依赖 CDN，断网双击 `index.html` 也能看；
3. 依赖越少越好，最好一只手数得过来。

于是就有了这个站点：**两个依赖**（`marked` 负责 Markdown，`highlight.js` 负责高亮），一个 `build.js`。

> [!NOTE]
> 这里的"400 行"指的是生成器主体逻辑。加上模板和样式当然不止，但那部分是产品，不是引擎。

## 整体结构

一次构建做的事情其实非常线性：

```text
content/*.md
    │
    ├─ 解析 front-matter ──→ 元数据（标题/日期/标签）
    │
    ├─ marked 渲染 ────────→ 正文 HTML + 目录树
    │      └─ hljs 高亮（构建时）
    │
    └─ 模板拼装 ───────────→ dist/*.html
```

关键在于**高亮放在构建时**完成，而不是在浏览器里跑 `highlight.js`。这样做有三个直接收益：

| 方案 | 首屏是否闪烁 | 额外请求 | 页面体积 |
| --- | --- | --- | --- |
| 客户端高亮 | 会（代码先黑后彩） | 1 个 JS + 1 个 CSS | 更大 |
| 构建时高亮 | 不会 | 0 | 更小 |

代价是构建会慢一点点——但一百篇文章也就在一两秒内。

## front-matter：不引入 gray-matter

大多数模板会引入 `gray-matter` 来解析头部元数据。但博客场景用到的 YAML 子集小得可怜，自己写一个 60 行的解析器就够了：

```js
export function parseFrontmatter(raw = '') {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {}, body: raw };

  const data = {};
  const lines = match[1].split(/\r?\n/);
  let currentKey = null;

  for (const line of lines) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentKey) {
      data[currentKey].push(coerce(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    currentKey = kv[1];
    data[kv[1]] = kv[2] ? coerce(kv[2]) : [];
  }

  return { data, body: raw.slice(match[0].length) };
}
```

需要处理的只有四种形态：

- `key: 简单值`
- `key: "带引号的值"`
- `key: [a, b, c]`（行内数组）
- `key:` 换行后跟 `- item`（多行数组）

> [!TIP]
> 如果你打算支持嵌套对象（比如 `seo.title`），就别自己写了，直接用 `gray-matter`。判断标准很简单：**解析器代码超过 100 行，就该换库**。

## 构建时高亮

`highlight.js` 的服务端用法很直接：

```js
import hljs from 'highlight.js';

function highlight(code, lang) {
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  }
  // 没写语言时自动识别一次
  return hljs.highlightAuto(code).value;
}
```

这里有个容易忽略的点：**`ignoreIllegals: true`**。不加它，代码里只要有一个语法错误，`hljs.highlight` 就会抛异常，整个构建直接挂掉。博客里的代码片段经常是伪代码或者不完整的，这个参数基本是必选项。

## 站点搜索：一次请求，本地打分

静态站点没有后端，但搜索并不难做。构建时把所有文章的纯文本抽出来生成一份索引：

```json
{
  "items": [
    {
      "kind": "post",
      "title": "用 400 行代码写一个静态站点生成器",
      "url": "posts/xxx.html",
      "tags": ["Node.js", "工程化"],
      "text": "为什么要自己写 博客这件事……"
    }
  ]
}
```

前端拉一次这个 JSON（几篇文章也就几十 KB），用最简单的**加权子串匹配**打分：

- 标题命中 → `+12`
- 标签命中 → `+7`
- 正文命中 → `+2`
- 所有关键词必须**全部命中**（AND 语义），避免结果发散

没错，这很土。但对几十到几百篇规模的个人博客来说，它比 Fuse.js 更快、更可预测，而且**结果永远是"用户能看懂为什么匹配"**。

> [!WARNING]
> 索引文件不宜无限膨胀。我抽取纯文本时截断到 1600 字，超过这个规模就该换倒排索引（比如 `lunr`）或者干脆上 Algolia。

## 一些踩过的坑

### 1. 标题锚点会撞车

如果两章都叫"小结"，直接 `slugify(title)` 会生成两个相同的 `id`，目录跳转就废了。用 Map 记录已用过的 id：

```js
if (usedIds.has(id)) {
  const next = usedIds.get(id) + 1;
  usedIds.set(id, next);
  id = `${id}-${next}`;
}
```

### 2. 中文 slug 是保留还是拼音化

`slugify('前端性能优化')` 直接保留中文得到 `前端性能优化`。URL 里会出现百分号编码，不美观，但：

- 现代浏览器地址栏会直接显示中文；
- 搜索引擎能正确索引；
- 复制粘贴分享不会出错。

而拼音化需要额外引入 `pinyin` 词库（几百 KB），信噪比不高，所以我选择保留中文。

### 3. `file://` 打开时 `fetch` 会被拦截

这是浏览器安全策略，无解。所以搜索功能在双击打开 HTML 时会失效。要完整功能就起个本地服务器：

```bash
npx serve dist
```

## 小结

整套东西的价值不在于"我又造了个轮子"，而在于**每一行代码我都知道它在干什么**。当我想加"阅读进度条"或者"代码复制按钮"时，不需要去翻框架的生命周期文档，直接写就行。

如果你也打算自己搭一个，我的建议是：

1. 先明确三条硬约束，越具体越好；
2. 用最少的依赖打通"Markdown → HTML"这条主链路；
3. 其余的（搜索、RSS、目录）都是锦上添花，可以后面慢慢加。

完整实现就在这个仓库里，欢迎参考。
