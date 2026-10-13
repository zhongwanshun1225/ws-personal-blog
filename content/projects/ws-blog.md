---
title: WS Blog
description: 你现在看到的这个站点。纯 Python 的静态博客生成器，两个依赖、零运行时框架，构建产物完全自包含。
date: 2026-10-08
stack: [Python, markdown-it-py, Pygments, 原生 CSS]
tags: [开源, 静态站点]
status: 活跃
featured: true
order: 1
repo: https://github.com/zhongwanshun1225/ws-personal-blog
demo: https://ws-blog.app.workbuddy.host
---

## 它解决什么问题

大多数博客框架要么太重（Next.js + MDX 全家桶），要么改起来处处受限。我想要的是一个**能完整读完源码、想改哪里就改哪里**的方案，而且构建链本身要干净：不引入任何需要编译的依赖，也不为了一个静态站拖进几百个包。

于是有了这个生成器。构建内核是纯 Python —— `build.py` 加 `wsblog/` 包，前端是原生 JavaScript，没有框架，也没有打包步骤。

## 关键实现

### 构建时语法高亮

高亮在 Python 侧用 `Pygments` 做词法分析，但输出沿用 highlight.js 的 class 体系，只需把 Pygments 的 token 类型映射成 `hljs-*`：

```python
def _hljs_class(token_type) -> str | None:
    """把 Pygments 的 token 类型映射到 highlight.js 的 class 名。"""
    if token_type in Comment:
        return "hljs-comment"
    if token_type in Keyword:
        return "hljs-keyword"
    if token_type in String:
        return "hljs-string"
    ...
```

好处是样式表里现成的深色高亮主题可以整段复用，页面却不必加载任何高亮脚本，也就没有"代码先黑后彩"的闪烁。

### 零依赖的 front-matter 解析

`wsblog/frontmatter.py` 用一百多行实现了博客场景够用的 YAML 子集，省掉了 PyYAML 及其依赖树。

### 一次构建，多份产物

同一份内容生成首页、归档、标签、项目、关于、404，以及搜索索引、RSS、sitemap 和每篇文章独立的静态详情页。爬虫拿到的就是完整 HTML，不依赖客户端渲染。

### 静态内容与在线内容合流

站点接了云数据库：登录、投稿、评论、点赞、收藏、站内通知都在线上。构建时把云端已发布文章拉下来，与 `content/` 下的 Markdown 一起合流进首页、标签、搜索、RSS 与 sitemap —— 两套来源在全站入口上保持一致。

## 技术选型对比

| 维度 | 本方案 | Hexo | VitePress |
| --- | --- | --- | --- |
| 运行时依赖 | 0 | 0 | Vue |
| 构建依赖总数 | 2 | 200+ | 100+ |
| 改造成本 | 极低 | 中 | 中高 |
| 搜索 | 内置轻量实现 | 需插件 | 内置 |

## 使用方式

```bash
pip install -r requirements.txt

python build.py                        # 构建到 dist/
python build.py --serve                # 本地预览，改文件自动重建（默认 4173）
python build.py --clean                # 先清空 dist/ 再构建
python build.py --new post "文章标题"   # 新建一篇文章
```

## 后续计划

- [x] 标签筛选与标签归档页
- [x] RSS 与 sitemap
- [x] 站内搜索
- [x] 在线投稿、评论与站内通知
- [x] 静态详情页与公开作者主页
- [ ] 图片自动压缩（AVIF/WebP 转换）
- [ ] 多语言支持
