# WS Blog · 极简技术风个人博客

一个 **Markdown 驱动**的静态博客生成器：深色技术风、零运行时框架、构建产物完全自包含。
构建系统是纯 Python，依赖只有两个包：`markdown-it-py`（Markdown 渲染）+ `Pygments`（代码高亮）。

- 新增文章 = 丢一个 `.md` 文件进 `content/posts/`
- 内置：标签筛选、站内搜索（Ctrl K）、文章目录、代码复制、RSS、sitemap、深色主题、移动端适配

---

## 快速开始

```bash
pip install -r requirements.txt   # 首次安装依赖（两个纯 Python 包）
python build.py --serve           # 启动本地预览（自动构建 + 热重建），默认 http://localhost:4173
python build.py                   # 只构建，产物在 dist/
```

> 常用命令：
>
> | 命令 | 作用 |
> | --- | --- |
> | `python build.py --serve` | 本地预览，改文件自动重建 |
> | `python build.py` | 生成 `dist/` |
> | `python build.py --new post "标题"` | 新建一篇文章草稿 |
> | `python build.py --new project "项目名"` | 新建一个项目卡片 |
> | `python build.py --clean` | 先清空 `dist/` 再生成 |
> | `python build.py --drafts` | 连草稿一起生成 |

---

## 写文章

在 `content/posts/` 下新建 `任意文件名.md`：

```md
---
title: 文章标题
date: 2026-10-12
tags: [Node.js, 工程化]
summary: 一句话摘要，会显示在列表和搜索结果里。
pinned: false        # 置顶（可选）
draft: false         # true 则构建时跳过（--serve / --drafts 下仍可见）
---

正文支持标准 Markdown，另外扩展了 GitHub 风格的提示块：

> [!NOTE]
> 说明类提示块。还支持 [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
```

**front-matter 字段说明（文章）：**

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 建议 | 不写则用文件名 |
| `date` | 建议 | 不写则用文件修改时间 |
| `tags` | 可选 | `[a, b]` 或 `a, b` 或多行 `- a` |
| `summary` | 可选 | 不写则自动截取正文前 110 字 |
| `slug` | 可选 | 自定义 URL，默认用文件名 |
| `pinned` | 可选 | 置顶显示 |
| `draft` | 可选 | 草稿，正式构建时跳过 |
| `updated` | 可选 | 更新时间，显示在文章头部 |

代码块写在 ` ```js ` 围栏里即可，高亮在**构建时**完成（Pygments），页面无闪烁、无额外请求。

## 写项目

在 `content/projects/` 下新建 `项目名.md`：

```md
---
title: 项目名
description: 一句话介绍（显示在卡片上）
date: 2026-10-12
stack: [TypeScript, React]     # 技术栈，显示为标签
tags: [开源]                   # 分类标签
status: 活跃                   # 活跃 / 维护中 / 归档（影响徽章颜色）
featured: true                 # 是否精选（显示在"精选"区）
order: 1                       # 同为精选时的排序权重
repo: https://github.com/你/仓库
demo: https://你的演示地址
docs: ""                       # 文档链接（可选）
---

正文是该项目的详情页，支持 Markdown 全部语法。
```

## 改站点信息

**所有个人信息都在 `site.config.json` 里**，打开就能看懂。改完跑一次 `python build.py` 生效。

⚠️ 当前是占位内容，正式使用前请至少改掉这些：

- `title` / `author` / `jobTitle` / `description` —— 站点名、你的名字、头衔、简介
- `hero` —— 首页大标题、口号、介绍、按钮
- `social` —— GitHub / 邮箱等链接（现在是 `your-github` 占位）
- `about.skills` / `about.timeline` —— 技能栈与经历
- `footer.note` / `footer.icp` —— 页脚说明 / 备案号
- `url` —— 部署后的正式域名（影响 RSS 和 sitemap）

「关于我」页面的正文在 `content/pages/about.md`。

---

## 自定义样式

全部样式在 `src/styles/main.css`，顶部是设计令牌（色板、圆角、字体），改几个变量就能换主题：

```css
:root {
  --bg: #0a0c11;        /* 页面底色 */
  --accent: #2dd4bf;    /* 主强调色（青） */
  --accent-2: #a78bfa;  /* 次强调色（紫） */
  ...
}
```

代码高亮配色在同文件的 `hljs-*` 区块，也是纯 CSS，直接改颜色即可
（Python 侧的 Pygments 输出沿用 `hljs-*` class，改样式无需动构建代码）。

## 账号与在线文章（可选的云能力）

站点内置了一套可选的账号体系，托管在 [WorkBuddy 云服务](https://www.workbuddy.cn)（CloudBase）上：

- **普通用户**：邮箱注册 / 登录，可以评论、点赞、收藏文章，查看个人中心
- **管理员**：同一账号可在登录页切换为管理员身份，进入 `/admin.html` 后台，在线发文、审核评论、管理用户与邮箱白名单

相关文件：

| 文件 | 作用 |
| --- | --- |
| `cloud.config.json` | 云应用公开配置（applicationId / endpoint / publishableKey） |
| `wsblog/cloudconf.py` | 构建期把它生成到 `dist/assets/cloud-config.js` |
| `src/scripts/cloud.js` | SDK 初始化、会话、双身份切换 |
| `src/scripts/auth.js` | 登录 / 注册 / 身份选择 |
| `src/scripts/interact.js` | 评论、点赞、收藏 |
| `src/scripts/account.js` / `admin.js` | 个人中心 / 后台 |
| `src/scripts/cloud-posts.js` / `cloud-markdown.js` | 云端文章列表与客户端 Markdown 渲染 |

⚠️ 注意两点：

1. **登录只在绑定的云域名下可用**。云服务按 Origin 校验，本地 `localhost` 与未登记的域名会被拒绝（页面会显示提示条）。此时站点仍作为纯静态博客正常工作，只是隐藏账号入口。
2. **管理员由邮箱白名单决定**（数据库表 `admin_emails`）。白名单里的邮箱在登录页选择「管理员」即可进入后台；后台里也能继续添加 / 移除白名单。白名单为空时没有任何人能进后台，首个管理员邮箱需要直接写入该表。

不想要云能力时，删掉 `cloud.config.json` 并把 `build.py` 里的 `cloud=True` 改为 `False` 即可，站点退化为纯静态博客。


## 项目结构

```
├── build.py               # 构建入口（CLI：构建 / 预览 / 脚手架）
├── requirements.txt       # Python 依赖（markdown-it-py、Pygments）
├── site.config.json       # 站点配置（个人信息、导航、页脚）
├── cloud.config.json      # 云服务公开配置（账号体系，可选）
├── content/
│   ├── posts/             # 文章（.md）
│   ├── projects/          # 项目（.md）
│   └── pages/about.md     # 关于页正文
├── wsblog/                # 构建内核（Python 包）
│   ├── util.py            #   转义、slug、日期、阅读时长
│   ├── frontmatter.py     #   front-matter 解析
│   ├── highlight.py       #   Pygments → hljs class 的高亮
│   ├── markdown.py        #   Markdown 渲染（TOC、提示块、表格）
│   ├── content.py         #   内容加载（文章 / 项目 / 页面 / 标签）
│   ├── cloudconf.py       #   云配置注入（生成 cloud-config.js）
│   ├── templates/         #   页面外壳与各页面模板
│   └── server.py          #   本地预览服务器（自动重建）
├── src/
│   ├── styles/main.css    # 全部样式
│   └── scripts/           # 浏览器端脚本（app.js 交互 + cloud*.js 账号体系）
└── dist/                  # 构建产物（直接部署这个目录）
```

## 部署

`dist/` 是纯静态目录，任何静态托管都能用：

**GitHub Pages**

1. 把仓库推到 GitHub；
2. 仓库 Settings → Pages → Source 选 **GitHub Actions**；
3. 用下面的 workflow（存为 `.github/workflows/deploy.yml`）：

```yaml
name: Deploy
on:
  push: { branches: [main] }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt && python build.py
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Vercel / Netlify / Cloudflare Pages**：构建命令 `pip install -r requirements.txt && python build.py`，输出目录 `dist`，无需其他配置。

## 常见问题

- **双击 `dist/index.html` 打开，搜索不可用？** 浏览器禁止 `file://` 下 `fetch`。用 `python build.py --serve` 或任意静态服务器打开即可。
- **新增文章没出现？** 检查 `draft: true` 是否没删；`--serve` 模式下草稿可见，正式构建时会跳过。
- **标签 URL 是中文正常吗？** 正常，现代浏览器与搜索引擎都能正确处理。
- **构建时输出 ⚠ 嵌套 `<a>` 警告？** 说明模板或插件把链接嵌套进了链接，浏览器会拆散外层锚点导致布局错乱，构建器会主动报警，请检查对应页面模板。
