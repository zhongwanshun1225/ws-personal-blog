"""界面文案的国际化（i18n）。

范围（刻意的边界）：

* **只覆盖界面文案** —— 导航、按钮、空态、页脚、筛选、排序、订阅与快捷键页等；
* **不翻译文章正文** —— 正文是作者写的中文内容，不做机器翻译；
* 默认语言取自 ``site.config.json`` 的 ``lang``（本站是 ``zh-CN``），
  构建时按默认语言把文案**写死进 HTML**（没有 JS 也能正常显示）；
  切到英文由浏览器端完成（``assets/i18n.js`` 按 ``data-i18n`` 替换 textContent）。

为什么不做「每个语言一套静态页」：那要 1) 把每一页复制一份、
2) 让英文页带着中文正文出现在 sitemap 里，对 SEO 与观感都是负收益。
界面级切换用 ``data-i18n`` + localStorage 更贴合「界面文案可切换」的目标，
并额外支持 ``?lang=en`` 便于分享与 hreflang 标注。

用法：

    from .i18n import T

    T("nav.search")              # → "搜索"（默认语言）
    T("nav.search", lang="en")   # → "Search"

模板里同时带上 data-i18n 属性，前端就能原地替换：

    f'<button data-i18n="nav.search">{T("nav.search")}</button>'
"""

from __future__ import annotations

import json

__all__ = [
    "LANGS",
    "DEFAULT_LANG",
    "LANG_LABELS",
    "MESSAGES",
    "normalize_lang",
    "t",
    "T",
    "build_i18n_js",
]

# 支持的语言：第一项是兜底语言
LANGS = ("zh-CN", "en")
DEFAULT_LANG = "zh-CN"

# 语言切换按钮上的缩写
LANG_LABELS = {"zh-CN": "中", "en": "EN"}

# 语言面板里的选项用「本族名」：中文就叫「中文」，英文就叫「English」。
# 这两个词在任何界面语言下都写成一样，所以不需要进字典。
LANG_ENDONYMS = {"zh-CN": "中文", "en": "English"}

# key → {lang: text}。新增文案必须两种语言都给，
# 缺了会回落默认语言（不会渲染成空字符串）。
MESSAGES: dict[str, dict[str, str]] = {
    # ---------- 通用 ----------
    "a11y.skip": {"zh-CN": "跳到主要内容", "en": "Skip to content"},
    "a11y.mainNav": {"zh-CN": "主导航", "en": "Main navigation"},
    "a11y.mobileNav": {"zh-CN": "移动端导航", "en": "Mobile navigation"},
    "a11y.toTop": {"zh-CN": "回到顶部", "en": "Back to top"},
    "a11y.menu": {"zh-CN": "展开菜单", "en": "Open menu"},
    "a11y.breadcrumb": {"zh-CN": "面包屑", "en": "Breadcrumb"},
    "a11y.openMenu": {"zh-CN": "展开菜单", "en": "Open menu"},
    "common.home": {"zh-CN": "首页", "en": "Home"},
    "common.more": {"zh-CN": "更多", "en": "More"},
    "common.all": {"zh-CN": "全部", "en": "All"},
    "common.back": {"zh-CN": "返回", "en": "Back"},
    "common.copy": {"zh-CN": "复制", "en": "Copy"},
    "common.copied": {"zh-CN": "已复制", "en": "Copied"},
    "common.copyFailed": {"zh-CN": "复制失败，请手动复制", "en": "Copy failed — please copy manually"},
    "common.copyFailedShort": {"zh-CN": "复制失败", "en": "Copy failed"},
    "common.linkCopied": {"zh-CN": "链接已复制", "en": "Link copied"},
    "common.linkCopyFailed": {"zh-CN": "复制失败，请手动复制地址栏", "en": "Copy failed — please copy the address bar"},
    "code.copied": {"zh-CN": "代码已复制到剪贴板", "en": "Code copied to clipboard"},
    "common.loading": {"zh-CN": "加载中…", "en": "Loading…"},
    "common.empty": {"zh-CN": "这里还没有内容。", "en": "Nothing here yet."},
    "common.minutes": {"zh-CN": "分钟", "en": "min"},
    "common.pinned": {"zh-CN": "置顶", "en": "Pinned"},

    # ---------- 顶栏 / 搜索 / 外观 ----------
    "nav.search": {"zh-CN": "搜索", "en": "Search"},
    "nav.searchAria": {"zh-CN": "搜索站内内容", "en": "Search this site"},
    "nav.language": {"zh-CN": "语言", "en": "Language"},
    "nav.switchLang": {"zh-CN": "切换语言", "en": "Switch language"},
    "nav.shortcuts": {"zh-CN": "快捷键", "en": "Shortcuts"},
    "auth.login": {"zh-CN": "登录 / 注册", "en": "Sign in"},
    "search.title": {"zh-CN": "站内搜索", "en": "Site search"},
    "search.placeholder": {"zh-CN": "搜索文章、项目、标签…", "en": "Search posts, projects, tags…"},
    "search.hintSelect": {"zh-CN": "↑↓ 选择", "en": "↑↓ to select"},
    "search.hintOpen": {"zh-CN": "↵ 打开", "en": "↵ to open"},
    "search.hintClose": {"zh-CN": "ESC 关闭", "en": "ESC to close"},
    "search.empty": {"zh-CN": "没有匹配的结果。", "en": "No matches found."},
    "search.emptyHint": {"zh-CN": "换个关键词试试，或到归档里翻翻。", "en": "Try another keyword, or browse the archive."},
    "search.tipKeys": {"zh-CN": "快捷键", "en": "Shortcuts"},
    "search.recent": {"zh-CN": "最近更新", "en": "Recent"},
    "search.startTyping": {"zh-CN": "输入关键词开始搜索", "en": "Start typing to search"},
    "search.noMatch": {"zh-CN": "没有找到与「{q}」相关的内容", "en": "Nothing matches “{q}”"},
    "search.searchingBody": {"zh-CN": "正在检索正文…", "en": "Searching full text…"},
    "search.kindPost": {"zh-CN": "文章", "en": "Post"},
    "search.kindCloudPost": {"zh-CN": "在线文章", "en": "Online"},
    "search.kindProject": {"zh-CN": "项目", "en": "Project"},
    "search.kindTag": {"zh-CN": "标签", "en": "Tag"},
    "appearance.title": {"zh-CN": "外观设置", "en": "Appearance"},
    "appearance.theme": {"zh-CN": "主题", "en": "Theme"},
    "appearance.themeAria": {"zh-CN": "主题模式", "en": "Theme mode"},
    "appearance.auto": {"zh-CN": "跟随系统", "en": "System"},
    "appearance.light": {"zh-CN": "浅色", "en": "Light"},
    "appearance.dark": {"zh-CN": "深色", "en": "Dark"},
    "appearance.accent": {"zh-CN": "强调色", "en": "Accent"},
    "appearance.accentAria": {"zh-CN": "强调色", "en": "Accent colour"},
    "appearance.hint": {
        "zh-CN": "设置仅保存在本机浏览器，不影响其他访客。",
        "en": "Saved in this browser only — it does not affect other visitors.",
    },
    "footer.otherLang": {"zh-CN": "English", "en": "中文"},

    # ---------- 列表 / 排序 / 加载更多 ----------
    "list.sort": {"zh-CN": "排序", "en": "Sort"},
    "list.sortLatest": {"zh-CN": "最新", "en": "Newest"},
    "list.sortHot": {"zh-CN": "最热", "en": "Popular"},
    "list.sortHotTitle": {"zh-CN": "按阅读、点赞与评论的热度排序", "en": "Ranked by views, likes and comments"},
    "list.loadMore": {"zh-CN": "加载更多", "en": "Load more"},
    "list.loadedAll": {"zh-CN": "已经到底了", "en": "You have reached the end"},
    "list.metricViews": {"zh-CN": "阅读", "en": "views"},
    "list.metricLikes": {"zh-CN": "点赞", "en": "likes"},
    "list.metricComments": {"zh-CN": "评论", "en": "comments"},

    # ---------- 首页 ----------
    "home.latest": {"zh-CN": "最新文章", "en": "Latest posts"},
    "home.projects": {"zh-CN": "项目作品", "en": "Projects"},
    "home.viewAll": {"zh-CN": "全部", "en": "All"},
    "home.viewAllProjects": {"zh-CN": "全部项目", "en": "All projects"},
    "home.filter": {"zh-CN": "标签筛选", "en": "Filter"},
    "home.empty": {"zh-CN": "没有匹配这个标签的文章。", "en": "No posts match this tag."},
    "home.activity": {"zh-CN": "站点动态", "en": "Latest activity"},
    "home.activityComments": {"zh-CN": "最近评论", "en": "Recent comments"},
    "home.activityPosts": {"zh-CN": "最近更新", "en": "Recently updated"},
    "home.noComments": {"zh-CN": "还没有评论，来做第一个。", "en": "No comments yet — be the first."},
    "home.subscribe": {"zh-CN": "订阅更新", "en": "Subscribe"},
    "home.subscribeHint": {
        "zh-CN": "不用天天来刷，新文章会送到你面前。",
        "en": "Get new posts without checking back.",
    },

    # ---------- 归档 / 标签 / 系列 ----------
    "archive.title": {"zh-CN": "归档", "en": "Archive"},
    "archive.page": {"zh-CN": "第 {n} 页", "en": "Page {n}"},
    "archive.summary": {"zh-CN": "共 {total} 篇文章，按发布时间归档。", "en": "{total} posts, grouped by year."},
    "archive.summaryPaged": {
        "zh-CN": "共 {total} 篇文章，按发布时间归档。当前第 {page} / {pages} 页。",
        "en": "{total} posts by year. Page {page} of {pages}.",
    },
    "archive.empty": {"zh-CN": "还没有文章。", "en": "No posts yet."},
    "archive.postsCount": {"zh-CN": "{n} 篇", "en": "{n} posts"},
    "tags.title": {"zh-CN": "标签", "en": "Tags"},
    "tags.summary": {"zh-CN": "按标签浏览全部文章。", "en": "Browse all posts by tag."},
    "tags.summaryCount": {"zh-CN": "共 {n} 个标签，覆盖 {m} 篇文章。", "en": "{n} tags across {m} posts."},
    "tags.empty": {"zh-CN": "还没有标签。", "en": "No tags yet."},
    "tag.title": {"zh-CN": "标签", "en": "Tag"},
    "tag.summary": {"zh-CN": "该标签下共 {n} 篇文章。", "en": "{n} posts with this tag."},
    "tags.goto": {"zh-CN": "标签", "en": "Tags"},
    "projects.summary": {"zh-CN": "做过的东西、正在做的东西，以及它们的取舍。", "en": "Things I've built, things I'm building, and the trade-offs behind them."},
    "projects.lead": {"zh-CN": "{n} 个已归档的项目。每个都附了源码或在线演示的入口，欢迎交流。", "en": "{n} archived projects — each links to source code or a live demo."},
    "projects.featured": {"zh-CN": "精选", "en": "Featured"},
    "projects.all": {"zh-CN": "全部项目", "en": "All projects"},
    "projects.emptyHint": {"zh-CN": "还没有项目。", "en": "No projects yet."},

    # ---------- 关于页 ----------
    "about.title": {"zh-CN": "关于", "en": "About"},
    "about.skills": {"zh-CN": "技能栈", "en": "Tech stack"},
    "about.timeline": {"zh-CN": "经历", "en": "Experience"},
    "about.findMe": {"zh-CN": "找到我", "en": "Find me"},
    "about.empty": {"zh-CN": "这个页面还没有内容。", "en": "This page doesn't have any content yet."},
    "projects.empty": {"zh-CN": "还没有项目。", "en": "No projects yet."},
    "series.title": {"zh-CN": "系列", "en": "Series"},
    "series.summary": {"zh-CN": "按系列成组阅读，按顺序看更连贯。", "en": "Read posts in order, grouped as series."},
    "series.of": {"zh-CN": "本文属于系列", "en": "Part of the series"},
    "series.count": {"zh-CN": "{n} 篇", "en": "{n} posts"},
    "series.empty": {"zh-CN": "还没有系列。给文章的 front-matter 加 series 字段即可成组。", "en": "No series yet."},
    "projects.title": {"zh-CN": "项目", "en": "Projects"},
    "projects.detail": {"zh-CN": "详情", "en": "Details"},

    # ---------- 文章页 ----------
    "posts.title": {"zh-CN": "文章", "en": "Posts"},
    "posts.loadFailed": {"zh-CN": "文章列表加载失败，请刷新重试。", "en": "Couldn't load the post list — please refresh."},
    "pagination.prev": {"zh-CN": "上一页", "en": "Previous"},
    "pagination.next": {"zh-CN": "下一页", "en": "Next"},
    "pagination.nav": {"zh-CN": "分页导航", "en": "Pagination"},
    "account.loadMore": {"zh-CN": "加载更多", "en": "Load more"},
    "account.showingRecent": {"zh-CN": "已显示最近 {n} 条", "en": "Showing the latest {n}"},

    # ---------- 在线文章列表 / 详情（云端内容） ----------
    "cloudPosts.title": {"zh-CN": "在线文章", "en": "Online posts"},
    "cloudPosts.lead": {
        "zh-CN": "站长与投稿用户发布的内容，共",
        "en": "Written by the site owner and contributors —",
    },
    "cloudPosts.unit": {
        "zh-CN": "篇。它们与静态文章一样支持点赞、收藏与评论。",
        "en": "in total, with likes, bookmarks and comments just like the static posts.",
    },
    "cloudPosts.writeCta": {"zh-CN": "我也要投稿", "en": "Submit a post"},
    "cloudPosts.empty": {"zh-CN": "还没有在线发布的文章。", "en": "No online posts yet."},
    "cloudPosts.pagination": {"zh-CN": "分页导航", "en": "Pagination"},
    "post.eyebrowDefault": {"zh-CN": "技术笔记", "en": "Notes"},
    "post.reading": {"zh-CN": "{n} 分钟阅读", "en": "{n} min read"},
    "post.words": {"zh-CN": "{n} 字", "en": "{n} words"},
    "post.updated": {"zh-CN": "更新于 {date}", "en": "Updated {date}"},
    "post.prev": {"zh-CN": "上一篇", "en": "Previous"},
    "post.next": {"zh-CN": "下一篇", "en": "Next"},
    "post.related": {"zh-CN": "相关文章", "en": "Related posts"},
    "post.toc": {"zh-CN": "目录", "en": "On this page"},
    "post.share": {"zh-CN": "分享这篇", "en": "Share this post"},
    "post.shareCopy": {"zh-CN": "复制链接", "en": "Copy link"},

    # ---------- 文章互动（点赞 / 收藏 / 评论） ----------
    "interact.like": {"zh-CN": "点赞", "en": "Like"},
    "interact.liked": {"zh-CN": "已点赞", "en": "Liked"},
    "interact.likeFail": {"zh-CN": "点赞没有生效", "en": "The like didn't go through"},
    "interact.unlikeFail": {"zh-CN": "取消点赞没有生效", "en": "Couldn't remove the like"},
    "interact.likeNeedLogin": {"zh-CN": "登录后才能点赞", "en": "Sign in to like"},
    "interact.bookmark": {"zh-CN": "收藏", "en": "Save"},
    "interact.bookmarked": {"zh-CN": "已收藏", "en": "Saved"},
    "interact.bookmarkFail": {"zh-CN": "收藏没有生效", "en": "Saving didn't go through"},
    "interact.unbookmarkFail": {"zh-CN": "取消收藏没有生效", "en": "Couldn't remove the bookmark"},
    "interact.bookmarkNeedLogin": {"zh-CN": "登录后才能收藏", "en": "Sign in to save"},
    "interact.views": {"zh-CN": "次阅读", "en": "views"},
    "interact.comments": {"zh-CN": "评论", "en": "Comments"},
    "interact.count": {"zh-CN": "条", "en": "comments"},
    "interact.gate": {"zh-CN": "登录后可以参与讨论。", "en": "Sign in to join the discussion."},
    "interact.replying": {"zh-CN": "正在回复", "en": "Replying to"},
    "interact.cancel": {"zh-CN": "取消", "en": "Cancel"},
    "interact.placeholder": {"zh-CN": "写下你的看法…", "en": "Share your thoughts…"},
    "interact.replyPlaceholder": {"zh-CN": "回复 {name} …", "en": "Reply to {name}…"},
    "interact.hint": {"zh-CN": "最多 1000 字 · 提交后需站长审核才公开", "en": "Up to 1000 characters · reviewed before it goes public"},
    "interact.submit": {"zh-CN": "发表评论", "en": "Post comment"},
    "interact.submitReply": {"zh-CN": "发表回复", "en": "Post reply"},
    "interact.empty": {"zh-CN": "还没有评论，来说点什么吧。", "en": "No comments yet — be the first."},
    "interact.loadFail": {"zh-CN": "评论暂时加载失败，请刷新重试。", "en": "Comments couldn't load — please refresh."},
    "interact.needLogin": {"zh-CN": "登录后才能评论", "en": "Sign in to comment"},
    "interact.needContent": {"zh-CN": "评论内容不能为空", "en": "Your comment is empty"},
    "interact.tooLong": {"zh-CN": "评论最多 1000 字", "en": "Comments are capped at 1000 characters"},
    "interact.saveFail": {"zh-CN": "评论没有保存成功，请稍后重试", "en": "Your comment didn't save — please try again"},
    "interact.pending": {"zh-CN": "评论已提交，站长通过后显示", "en": "Comment submitted — it appears once approved"},
    "interact.pendingReply": {"zh-CN": "回复已提交，站长通过后显示", "en": "Reply submitted — it appears once approved"},
    "interact.deleted": {"zh-CN": "评论已删除", "en": "Comment deleted"},
    "interact.confirmDelete": {"zh-CN": "确定删除这条评论吗？", "en": "Delete this comment?"},
    "interact.onlyMine": {"zh-CN": "只能删除自己的评论", "en": "You can only delete your own comments"},
    "interact.footerReply": {"zh-CN": "回复", "en": "Reply"},
    "interact.footerDelete": {"zh-CN": "删除", "en": "Delete"},
    "interact.pendingBadge": {"zh-CN": "审核中", "en": "In review"},
    "interact.replyNeedLogin": {"zh-CN": "登录后才能回复", "en": "Sign in to reply"},
    "interact.deleteFail": {"zh-CN": "删除失败，请稍后重试", "en": "Couldn't delete — please try again"},
    "interact.published": {"zh-CN": "评论已发布", "en": "Comment posted"},
    "interact.publishedReply": {"zh-CN": "回复已发布", "en": "Reply posted"},

    # ---------- 登录 / 注册 ----------
    "auth.title": {"zh-CN": "登录 / 注册", "en": "Sign in / Sign up"},
    "auth.lead": {"zh-CN": "同一个入口：没账号就直接注册，有账号就登录。", "en": "One door for both — we create your account on first sign-in."},
    "auth.tabPassword": {"zh-CN": "密码登录", "en": "Password"},
    "auth.tabCode": {"zh-CN": "邮箱验证码", "en": "Email code"},
    "auth.method": {"zh-CN": "登录方式", "en": "Sign-in method"},
    "auth.email": {"zh-CN": "邮箱", "en": "Email"},
    "auth.emailPlaceholder": {"zh-CN": "you@example.com", "en": "you@example.com"},
    "auth.password": {"zh-CN": "密码", "en": "Password"},
    "auth.passwordPlaceholder": {"zh-CN": "输入密码", "en": "Enter your password"},
    "auth.codePlaceholder": {"zh-CN": "6 位验证码", "en": "6-digit code"},
    "auth.newPasswordPlaceholder": {"zh-CN": "新账号首次登录请设置密码", "en": "Set a password on your first sign-in"},
    "auth.sendCode": {"zh-CN": "发送验证码", "en": "Send code"},
    "auth.submitPassword": {"zh-CN": "登录", "en": "Sign in"},
    "auth.submitCode": {"zh-CN": "登录 / 注册", "en": "Continue"},
    "auth.forgot": {"zh-CN": "忘记密码？", "en": "Forgot your password?"},
    "auth.resetTitle": {"zh-CN": "重置密码", "en": "Reset password"},
    "auth.resetCodePlaceholder": {"zh-CN": "邮件里的验证码", "en": "Code from the email"},
    "auth.resetNew": {"zh-CN": "至少 6 位", "en": "At least 6 characters"},
    "auth.resetRepeat": {"zh-CN": "再输入一次", "en": "Type it again"},
    "auth.resetSubmit": {"zh-CN": "重设密码", "en": "Reset password"},
    "auth.backToLogin": {"zh-CN": "返回登录", "en": "Back to sign in"},
    "auth.asideTitle": {"zh-CN": "一个入口，权限自动生效", "en": "One door in — permissions follow your account"},
    "auth.asideText": {
        "zh-CN": "所有人用同一个入口登录：填邮箱和密码就行，没有账号的话首次登录会自动创建。能做什么由账号本身决定，不需要提前选入口。",
        "en": "Everyone signs in the same way: email plus password, and your account is created on first sign-in. What you can do is decided by the account itself — no need to pick a role up front.",
    },
    "auth.roleUser": {"zh-CN": "普通账号", "en": "Regular account"},
    "auth.roleUserDesc": {"zh-CN": "评论 · 点赞 · 收藏 · 个人资料", "en": "Comments · likes · bookmarks · profile"},
    "auth.roleAdmin": {"zh-CN": "管理员账号", "en": "Admin account"},
    "auth.roleAdminDesc": {"zh-CN": "登录后可自选：以普通用户浏览，或进入后台", "en": "After signing in you choose: browse as a reader, or open the admin panel"},
    "auth.asideFoot": {"zh-CN": "管理员由邮箱白名单认定，登录后才会出现身份选择。", "en": "Admins are determined by an email allow-list; the role picker only appears after sign-in."},
    "auth.cardLead": {"zh-CN": "邮箱 + 密码登录；没有账号的话，首次登录会自动创建。", "en": "Sign in with email and password; if you don't have an account yet, one is created for you."},
    "auth.code": {"zh-CN": "验证码", "en": "Code"},
    "auth.getCode": {"zh-CN": "获取验证码", "en": "Get code"},
    "auth.signupPasswordLabel": {"zh-CN": "设置密码（仅新用户需要）", "en": "Set a password (new users only)"},
    "auth.privacy": {"zh-CN": "登录即表示你同意本站以最小必要范围保存账号信息。", "en": "By signing in you agree that this site stores the minimum account information it needs."},
    "auth.resetLead": {"zh-CN": "填写注册邮箱获取验证码，验证通过后直接设置新密码并登录。", "en": "Enter your email to get a code — then set a new password and sign straight in."},
    "auth.resetNewLabel": {"zh-CN": "新密码", "en": "New password"},
    "auth.resetConfirmLabel": {"zh-CN": "确认新密码", "en": "Confirm new password"},
    "auth.resetSubmitFull": {"zh-CN": "重置密码并登录", "en": "Reset password and sign in"},

    # ---------- 404 ----------
    "notFound.title": {"zh-CN": "页面不存在", "en": "Page not found"},
    "notFound.lead": {
        "zh-CN": "这个地址没有对应的内容，可能是链接过期，或者文章被改名了。",
        "en": "Nothing lives at this address — the link may be stale, or the post was renamed.",
    },
    "notFound.searchPlaceholder": {"zh-CN": "搜一下你想找的内容…", "en": "Search for what you need…"},
    "notFound.latest": {"zh-CN": "最新文章", "en": "Latest posts"},
    "notFound.hotTags": {"zh-CN": "热门标签", "en": "Popular tags"},
    "notFound.search": {"zh-CN": "搜索站内内容", "en": "Search this site"},
    "notFound.backHome": {"zh-CN": "返回首页", "en": "Back to home"},

    # ---------- 离线兜底页（Service Worker） ----------
    "offline.title": {"zh-CN": "当前没有网络连接", "en": "You're offline"},
    "offline.lead": {
        "zh-CN": "这个页面还没有被缓存。恢复网络后刷新即可；已浏览过的页面在离线状态下仍然可以打开。",
        "en": "This page hasn't been cached yet. Refresh once you're back online — pages you've already visited still open offline.",
    },
    "offline.retry": {"zh-CN": "重试首页", "en": "Retry home page"},

    # ---------- 订阅页 ----------
    "subscribe.title": {"zh-CN": "订阅更新", "en": "Subscribe"},
    "subscribe.lead": {
        "zh-CN": "两种方式：RSS 立刻可用；邮件订阅登记后，等发信服务接好就会开始投递。",
        "en": "Two ways: RSS works right now; email subscriptions are recorded and will start once delivery is wired up.",
    },
    "subscribe.rssTitle": {"zh-CN": "RSS / Atom", "en": "RSS / Atom"},
    "subscribe.rssDesc": {
        "zh-CN": "任何阅读器都能订阅：Feedly、Inoreader、NetNewsWire、Folo、或者浏览器自带的阅读模式。",
        "en": "Works with any reader: Feedly, Inoreader, NetNewsWire, Folo, or your browser's built-in reader.",
    },
    "subscribe.rssCopy": {"zh-CN": "复制订阅地址", "en": "Copy feed URL"},
    "subscribe.rssOpen": {"zh-CN": "打开 feed.xml", "en": "Open feed.xml"},
    "subscribe.emailTitle": {"zh-CN": "邮件订阅", "en": "Email subscription"},
    "subscribe.emailDesc": {
        "zh-CN": "留个邮箱，我会在有新文章时通知你。随时可退订，邮箱只用于发信，不做其他用途。",
        "en": "Leave your email and I'll let you know about new posts. Unsubscribe anytime; the address is used only for sending.",
    },
    "subscribe.emailPlaceholder": {"zh-CN": "you@example.com", "en": "you@example.com"},
    "subscribe.emailSubmit": {"zh-CN": "订阅", "en": "Subscribe"},
    "subscribe.emailSubmitting": {"zh-CN": "提交中…", "en": "Submitting…"},
    "subscribe.emailNeedEmail": {"zh-CN": "先填一个邮箱。", "en": "Please enter an email first."},
    "subscribe.emailPending": {
        "zh-CN": "已登记。当前还没接入发信服务，等接好后开始投递；重复提交不会重复登记。",
        "en": "Recorded. Delivery isn't wired up yet — submitting again won't duplicate anything.",
    },
    "subscribe.emailInvalid": {"zh-CN": "邮箱格式看起来不对，检查一下。", "en": "That email doesn't look right — please check it."},
    "subscribe.emailOffline": {
        "zh-CN": "暂时连不上服务器，稍后再试；也可以先用 RSS。",
        "en": "Can't reach the server right now — try again later, or use RSS in the meantime.",
    },
    "subscribe.privacyNote": {
        "zh-CN": "隐私说明：订阅只保存邮箱与语言偏好，不记录 IP，也不与第三方共享。",
        "en": "Privacy: only your email and language preference are stored. No IP logging, no third-party sharing.",
    },

    # ---------- 快捷键页 ----------
    "shortcuts.title": {"zh-CN": "快捷键", "en": "Keyboard shortcuts"},
    "shortcuts.lead": {"zh-CN": "全站可用的键盘操作，不用离开键盘。", "en": "Everything you can do without leaving the keyboard."},
    "shortcuts.open": {"zh-CN": "唤起搜索", "en": "Open search"},
    "shortcuts.openAlt": {"zh-CN": "唤起搜索（另一个键）", "en": "Open search (alternative)"},
    "shortcuts.thisPage": {"zh-CN": "打开本页", "en": "Open this page"},
    "shortcuts.close": {"zh-CN": "关闭浮层 / 退出输入框", "en": "Close overlay / leave input"},
    "shortcuts.navigate": {"zh-CN": "在搜索结果里上下移动", "en": "Move through results"},
    "shortcuts.enter": {"zh-CN": "打开选中的结果", "en": "Open the selected result"},
    "shortcuts.toTop": {"zh-CN": "回到顶部", "en": "Back to top"},
    "shortcuts.tip": {"zh-CN": "在任意页面按 ? 都能回到这里。", "en": "Press ? on any page to come back here."},
}


def normalize_lang(value) -> str:
    """把任意输入规整成受支持的语言码。"""
    text = str(value or "").strip()
    if not text:
        return DEFAULT_LANG
    lowered = text.lower().replace("_", "-")
    if lowered.startswith("en"):
        return "en"
    if lowered.startswith("zh"):
        return "zh-CN"
    return DEFAULT_LANG if text not in LANGS else text


def t(key: str, lang: str | None = None, **kwargs) -> str:
    """取一条界面文案；带 ``{name}`` 占位符时用 kwargs 填充。"""
    entry = MESSAGES.get(key)
    if not entry:
        # 缺 key 时把 key 原样吐出来，比静默空字符串好排查
        return key
    text = entry.get(normalize_lang(lang)) or entry.get(DEFAULT_LANG) or key
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, IndexError, ValueError):
            return text
    return text


# 模板里写起来更顺手的短别名（T 大写是为了和 HTML 变量区分开）
T = t


def build_i18n_js(default_lang: str = DEFAULT_LANG) -> str:
    """生成 ``assets/i18n.js``。

    浏览器端职责：
      1. 读偏好（localStorage → ``?lang=`` → 默认语言）；
      2. 按 ``data-i18n`` / ``data-i18n-attr`` 就地替换文案；
      3. 同步 ``<html lang>`` 与 ``data-lang``；
      4. 顶栏语言按钮点击后切换并记忆。

    ``data-i18n-attr`` 的写法是 ``属性:key,属性:key``，
    例如 ``data-i18n-attr="placeholder:search.placeholder"``。

    ``data-i18n-config`` 用于「来自 site.config.json 的文案」——导航标签、
    页脚说明这类内容不进内置字典，构建时把中英两版写成 JSON 属性，
    由这里的 apply() 按语言挑选。
    """
    payload = {key: {lang: (entry.get(lang) or entry.get(DEFAULT_LANG) or "") for lang in LANGS}
               for key, entry in MESSAGES.items()}
    return (
        "/* 本文件由 build.py 自动生成，请勿手改；改 wsblog/i18n.py 后重新构建。 */\n"
        "(function () {\n"
        "  'use strict';\n"
        f"  var DICT = {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))};\n"
        f"  var LANGS = {json.dumps(list(LANGS))};\n"
        f"  var DEFAULT_LANG = {json.dumps(default_lang)};\n"
        "  var KEY = 'wsblog:lang';\n"
        "  function normalize(v) {\n"
        "    v = String(v || '').toLowerCase().replace('_', '-');\n"
        "    if (v.indexOf('en') === 0) return 'en';\n"
        "    if (v.indexOf('zh') === 0) return 'zh-CN';\n"
        "    return '';\n"
        "  }\n"
        "  function fromQuery() {\n"
        "    var m = /[?&]lang=([^&#]+)/.exec(location.search);\n"
        "    return m ? normalize(decodeURIComponent(m[1])) : '';\n"
        "  }\n"
        "  function stored() {\n"
        "    try { return normalize(localStorage.getItem(KEY)); } catch (e) { return ''; }\n"
        "  }\n"
        "  function t(key, lang) {\n"
        "    var entry = DICT[key];\n"
        "    if (!entry) return key;\n"
        "    return entry[lang] || entry[DEFAULT_LANG] || key;\n"
        "  }\n"
        "  function apply(lang) {\n"
        "    var nodes = document.querySelectorAll('[data-i18n]');\n"
        "    for (var i = 0; i < nodes.length; i++) {\n"
        "      var key = nodes[i].getAttribute('data-i18n');\n"
        "      var entry = DICT[key];\n"
        "      if (entry && (entry[lang] || entry[DEFAULT_LANG])) {\n"
        "        var text = entry[lang] || entry[DEFAULT_LANG];\n"
        "        // data-i18n-args 用于带占位符的文案：\n"
        "        //   '3'                  → 替换 {n}\n"
        "        //   '{\"n\":3,\"m\":5}'      → 逐个替换 {n} / {m}\n"
        "        var args = nodes[i].getAttribute('data-i18n-args');\n"
        "        if (args !== null) {\n"
        "          if (args.charAt(0) === '{') {\n"
        "            try {\n"
        "              var map = JSON.parse(args);\n"
        "              for (var mk in map) {\n"
        "                if (Object.prototype.hasOwnProperty.call(map, mk)) {\n"
        "                  text = text.split('{' + mk + '}').join(map[mk]);\n"
        "                }\n"
        "              }\n"
        "            } catch (e) { /* 解析失败就原样输出，不阻断整页切换 */ }\n"
        "          } else {\n"
        "            text = text.split('{n}').join(args);\n"
        "          }\n"
        "        }\n"
        "        nodes[i].textContent = text;\n"
        "      }\n"
        "    }\n"
        "    var attrs = document.querySelectorAll('[data-i18n-attr]');\n"
        "    for (var j = 0; j < attrs.length; j++) {\n"
        "      var spec = attrs[j].getAttribute('data-i18n-attr');\n"
        "      var pairs = spec.split(',');\n"
        "      for (var k = 0; k < pairs.length; k++) {\n"
        "        var bits = pairs[k].split(':');\n"
        "        if (bits.length < 2) continue;\n"
        "        var attrKey = DICT[bits[1]];\n"
        "        if (attrKey && (attrKey[lang] || attrKey[DEFAULT_LANG])) {\n"
        "          attrs[j].setAttribute(bits[0], attrKey[lang] || attrKey[DEFAULT_LANG]);\n"
        "        }\n"
        "      }\n"
        "    }\n"
        "    // 站点配置自带的文案（导航标签、页脚说明等）不在内置字典里：\n"
        "    // 它们的中英两版存在 site.config.json，构建时以 JSON 写进属性，\n"
        "    // 这里按当前语言取一版，缺哪版就回落到默认语言。\n"
        "    var cfgNodes = document.querySelectorAll('[data-i18n-config]');\n"
        "    for (var c = 0; c < cfgNodes.length; c++) {\n"
        "      var map = null;\n"
        "      try { map = JSON.parse(cfgNodes[c].getAttribute('data-i18n-config')); } catch (e) { map = null; }\n"
        "      if (!map) continue;\n"
        "      var value = map[lang] || map[DEFAULT_LANG];\n"
        "      if (!value) {\n"
        "        for (var mk in map) {\n"
        "          if (Object.prototype.hasOwnProperty.call(map, mk) && map[mk]) { value = map[mk]; break; }\n"
        "        }\n"
        "      }\n"
        "      if (value) cfgNodes[c].textContent = value;\n"
        "    }\n"
        "    var prev = normalize(document.documentElement.getAttribute('data-lang-default') || DEFAULT_LANG);\n"
        "    document.documentElement.lang = lang || prev || DEFAULT_LANG;\n"
        "    document.documentElement.setAttribute('data-lang', lang);\n"
        "    var label = document.querySelector('[data-lang-label]');\n"
        "    if (label) label.textContent = (lang === 'en') ? 'EN' : '中';\n"
        "    var btns = document.querySelectorAll('[data-lang-set]');\n"
        "    for (var n = 0; n < btns.length; n++) {\n"
        "      var on = btns[n].getAttribute('data-lang-set') === lang;\n"
        "      btns[n].setAttribute('aria-checked', on ? 'true' : 'false');\n"
        "      btns[n].classList.toggle('is-active', on);\n"
        "    }\n"
        "  }\n"
        "  function setLang(lang, persist) {\n"
        "    var next = normalize(lang) || DEFAULT_LANG;\n"
        "    if (persist !== false) { try { localStorage.setItem(KEY, next); } catch (e) {} }\n"
        "    apply(next);\n"
        "    document.dispatchEvent(new CustomEvent('wsblog:langchange', { detail: { lang: next } }));\n"
        "    return next;\n"
        "  }\n"
        "  var initial = fromQuery() || stored() || DEFAULT_LANG;\n"
        "  window.WSBlogI18n = {\n"
        "    dict: DICT,\n"
        "    langs: LANGS,\n"
        "    defaultLang: DEFAULT_LANG,\n"
        "    t: function (key) { return t(key, current); },\n"
        "    apply: apply,\n"
        "    setLang: setLang,\n"
        "    get lang() { return current; }\n"
        "  };\n"
        "  var current = initial;\n"
        "  function boot() {\n"
        "    apply(current);\n"
        "    // 面板开合：点按钮开、选完关、点外面关、Esc 关\n"
        "    var wrap = document.querySelector('[data-lang]');\n"
        "    var toggle = document.querySelector('[data-lang-toggle]');\n"
        "    var panel = document.querySelector('[data-lang-panel]');\n"
        "    function setOpen(open) {\n"
        "      if (!panel || !toggle) return;\n"
        "      if (open) { panel.removeAttribute('hidden'); toggle.setAttribute('aria-expanded', 'true'); }\n"
        "      else { panel.setAttribute('hidden', ''); toggle.setAttribute('aria-expanded', 'false'); }\n"
        "    }\n"
        "    if (toggle && panel) {\n"
        "      toggle.addEventListener('click', function (ev) {\n"
        "        ev.stopPropagation();\n"
        "        setOpen(panel.hasAttribute('hidden'));\n"
        "      });\n"
        "      panel.addEventListener('click', function (ev) { ev.stopPropagation(); });\n"
        "      document.addEventListener('click', function () { setOpen(false); });\n"
        "      document.addEventListener('keydown', function (ev) {\n"
        "        if (ev.key === 'Escape') setOpen(false);\n"
        "      });\n"
        "    }\n"
        "    // 选项的事件必须绑在面板这一层：面板自己 stopPropagation（避免\n"
        "    // 触发「点外面就关」），所以它内部的点击传不到 document。\n"
        "    function pick(ev) {\n"
        "      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-lang-set]') : null;\n"
        "      if (!btn) return;\n"
        "      ev.preventDefault();\n"
        "      current = setLang(btn.getAttribute('data-lang-set'));\n"
        "      setOpen(false);\n"
        "    }\n"
        "    if (panel) panel.addEventListener('click', pick);\n"
        "    else document.addEventListener('click', pick);\n"
        "  }\n"
        "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);\n"
        "  else boot();\n"
        "})();\n"
    )
