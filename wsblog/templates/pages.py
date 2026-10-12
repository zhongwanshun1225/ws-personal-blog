"""各页面主体模板。

每个函数只返回 ``<main>`` 内部的 HTML，外层由 ``layout()`` 包裹。
"""

from __future__ import annotations

from urllib.parse import quote

from ..util import escape_html as esc, parse_date, slugify
from .layout import icons

__all__ = [
    "home_page",
    "post_page",
    "post_interact_block",
    "projects_page",
    "project_detail_page",
    "about_page",
    "tags_page",
    "tag_page",
    "login_page",
    "account_page",
    "admin_page",
    "cloud_posts_page",
    "cloud_post_page",
    "not_found_page",
]

_WEEKDAYS_CN = ("周日", "周一", "周二", "周三", "周四", "周五", "周六")


def _is_http(url) -> bool:
    text = str(url or "").lower()
    return text.startswith("http://") or text.startswith("https://")


# ---------- 局部小工具 ----------

def _short_date(value) -> str:
    """2026-10-12 这种紧凑日期，列表里用。"""
    parsed = parse_date(value)
    if parsed is None:
        return ""
    local = parsed.astimezone()
    return f"{local.year}-{local.month:02d}-{local.day:02d}"


def _full_date(value) -> str:
    parsed = parse_date(value)
    if parsed is None:
        return ""
    local = parsed.astimezone()
    weekday = _WEEKDAYS_CN[(local.weekday() + 1) % 7]
    return f"{local.year} 年 {local.month} 月 {local.day} 日 · {weekday}"


def _tag_chips(tags, root: str, linked: bool = True) -> str:
    parts = []
    for tag in tags:
        if linked:
            parts.append(f'<a class="tag" href="{root}tags/{slugify(tag)}.html">{esc(tag)}</a>')
        else:
            parts.append(f'<span class="tag">{esc(tag)}</span>')
    return "".join(parts)


def _post_item(post: dict, root: str, config: dict) -> str:
    """文章列表项。

    注意：整个卡片用「拉伸链接」模式（标题里的 a 用 ::before 铺满卡片），
    而不是把 <a> 当卡片容器 —— 因为卡片里的标签也是链接，
    HTML 不允许 <a> 嵌套，嵌套会让解析器拆散外层锚点、破坏布局。
    """
    options = config.get("options") or {}
    show_reading = options.get("showReadingTime", True) is not False
    reading = f"<span>{post['reading_time']} 分钟</span>" if show_reading else ""
    pinned = '<span class="pinned-flag">置顶</span> ' if post.get("pinned") else ""
    tags_attr = " ".join(slugify(tag) for tag in post["tags"])

    return f"""<li class="post-item" data-tags="{esc(tags_attr)}">
  <div class="post-item__link">
    <div class="post-item__date">{_short_date(post["date"])}{reading}</div>
    <div class="post-item__main">
      <h3 class="post-item__title"><a class="stretch-link" href="{root}{post["url"]}">{pinned}{esc(post["title"])}</a></h3>
      <p class="post-item__summary">{esc(post["summary"])}</p>
      <div class="post-item__meta">{_tag_chips(post["tags"], root)}</div>
    </div>
  </div>
</li>"""


def _project_card(project: dict, root: str) -> str:
    title = str(project.get("title") or "P").strip()
    glyph = esc(title[:2])

    links = "".join(
        f'<a class="project-link" href="{esc(link["url"])}" target="_blank" rel="noopener noreferrer">'
        f'{icons.get(link["kind"]) or icons["link"]}<span>{esc(link["label"])}</span></a>'
        for link in project["links"]
    )
    featured = '<span class="featured-flag">Featured</span>' if project.get("featured") else ""
    stack_html = (
        '<div class="project-card__stack">'
        + "".join(f'<span class="chip">{esc(item)}</span>' for item in project["stack"])
        + "</div>"
        if project["stack"]
        else ""
    )
    status_html = (
        f'<span class="status-badge" data-status="{esc(project["status"])}">{esc(project["status"])}</span>'
        if project.get("status")
        else ""
    )

    return f"""<article class="project-card reveal">
  <div class="project-card__banner"><span class="project-card__glyph">{glyph}</span></div>
  <div class="project-card__body">
    <h3 class="project-card__title">{esc(project["title"])}{featured}</h3>
    <p class="project-card__desc">{esc(project["description"])}</p>
    {stack_html}
    <div class="project-card__foot">
      <a class="project-link" href="{root}{project["url"]}">{icons["sparkle"]}<span>详情</span></a>
      {status_html}
      {links}
    </div>
  </div>
</article>"""


# ---------- 首页 ----------

def home_page(*, config: dict, posts: list, projects: list, tags: list, root: str = "") -> str:
    hero = config.get("hero") or {}

    # 统计数字支持 auto: 前缀，从实际内容里取
    stat_parts = []
    for stat in hero.get("stats") or []:
        value = stat.get("value")
        if value == "auto:posts":
            value = str(len(posts))
        elif value == "auto:projects":
            value = str(len(projects))
        elif value == "auto:tags":
            value = str(len(tags))
        stat_parts.append(
            f'<div class="stat"><div class="stat__value">{esc(value)}<span>+</span></div>'
            f'<div class="stat__label">{esc(stat.get("label"))}</div></div>'
        )
    stats = "".join(stat_parts)

    action_parts = []
    for index, action in enumerate(
        [a for a in (hero.get("primaryAction"), hero.get("secondaryAction")) if a]
    ):
        btn_class = "btn btn--primary" if index == 0 else "btn btn--ghost"
        arrow = " →" if index == 0 else ""
        action_parts.append(
            f'<a class="{btn_class}" href="{root}{esc(action.get("url"))}">'
            f'{esc(action.get("label"))}{arrow}</a>'
        )
    actions = "".join(action_parts)

    filter_parts = [
        '<button class="chip is-active" type="button" data-filter="all">全部'
        f'<span class="chip__count">{len(posts)}</span></button>'
    ]
    for tag in tags[:8]:
        filter_parts.append(
            f'<button class="chip" type="button" data-filter="{esc(slugify(tag["name"]))}">'
            f'{esc(tag["name"])}<span class="chip__count">{tag["count"]}</span></button>'
        )
    filter_chips = "".join(filter_parts)

    keywords = (config.get("keywords") or ["技术", "项目"])[:3]
    eyebrow = esc(" / ".join(str(k) for k in keywords))
    slogan = f'<p class="hero__slogan">{esc(hero.get("slogan"))}</p>' if hero.get("slogan") else ""
    intro = f'<p class="hero__intro">{esc(hero.get("intro"))}</p>' if hero.get("intro") else ""
    actions_block = f'<div class="hero__actions">{actions}</div>' if actions else ""
    stats_block = f'<div class="hero__stats">{stats}</div>' if stats else ""

    post_list = "\n    ".join(_post_item(post, root, config) for post in posts)

    featured_projects = projects[:3]
    if featured_projects:
        grid = "".join(_project_card(project, root) for project in featured_projects)
        projects_block = f"""<section class="wrap section" id="projects">
  <div class="section__head">
    <h2 class="section__title">项目作品</h2>
    <a class="section__more" href="{root}projects.html">全部项目 →</a>
  </div>
  <div class="project-grid">{grid}</div>
</section>"""
    else:
        projects_block = ""

    return f"""<section class="hero">
  <div class="wrap">
    <div class="hero__grid"></div>
    <span class="eyebrow">{eyebrow}</span>
    <h1 class="hero__title">{esc(hero.get("greeting") or "Hello, 我是")} <em>{esc(hero.get("headline") or config.get("author") or "")}</em></h1>
    {slogan}
    {intro}
    {actions_block}
    {stats_block}
  </div>
</section>

<section class="wrap section" id="posts">
  <div class="section__head">
    <h2 class="section__title">最新文章</h2>
    <a class="section__more" href="{root}tags.html">全部标签 →</a>
  </div>
  <div class="toolbar">
    <span class="toolbar__label">Filter</span>
    <div class="chip-row" data-filter-row>{filter_chips}</div>
  </div>
  <ul class="post-list" data-post-list>
    {post_list}
  </ul>
  <div class="empty-state" data-empty-state hidden>没有匹配这个标签的文章。</div>
</section>

{projects_block}
"""


# ---------- 文章详情 ----------

def post_page(*, config: dict, post: dict, prev_post, next_post, root: str = "../") -> str:
    options = config.get("options") or {}
    show_toc = options.get("showToc", True) is not False and len(post["toc"]) > 2

    if show_toc:
        toc_items = "".join(
            f'<li><a class="toc__link" href="#{esc(heading["id"])}" data-depth="{heading["depth"]}">'
            f'{esc(heading["text"])}</a></li>'
            for heading in post["toc"]
        )
        toc_html = f"""<aside class="toc" data-toc>
  <div class="toc__title">On this page</div>
  <ul class="toc__list">
    {toc_items}
  </ul>
</aside>"""
    else:
        toc_html = ""

    nav_parts = []
    if prev_post:
        nav_parts.append(
            f'<a class="post-nav__item" href="{root}{prev_post["url"]}">'
            '<span class="post-nav__label">← 上一篇</span>'
            f'<span class="post-nav__title">{esc(prev_post["title"])}</span></a>'
        )
    if next_post:
        nav_parts.append(
            f'<a class="post-nav__item post-nav__item--next" href="{root}{next_post["url"]}">'
            '<span class="post-nav__label">下一篇 →</span>'
            f'<span class="post-nav__title">{esc(next_post["title"])}</span></a>'
        )
    nav_html = f'<div class="post-nav">\n  {"".join(nav_parts)}\n</div>' if nav_parts else ""

    updated_html = (
        f'<span class="meta-dot"></span><span class="meta-text">更新于 {_short_date(post["updated"])}</span>'
        if post.get("updated")
        else ""
    )
    summary_html = f'<p class="article-head__summary">{esc(post["summary"])}</p>' if post.get("summary") else ""

    return f"""<div class="wrap">
  <div class="page-head">
    <nav class="breadcrumb" aria-label="面包屑">
      <a href="{root}index.html">首页</a>
      <span class="breadcrumb__sep">/</span>
      <span>文章</span>
    </nav>
    <header class="article-head">
      <span class="eyebrow">{esc(post["tags"][0] if post["tags"] else "技术笔记")}</span>
      <h1 class="article-head__title">{esc(post["title"])}</h1>
      <div class="article-head__meta">
        <span class="meta-text">{_full_date(post["date"])}</span>
        <span class="meta-dot"></span>
        <span class="meta-text">{post["reading_time"]} 分钟阅读</span>
        <span class="meta-dot"></span>
        <span class="meta-text">{post["words"]} 字</span>
        {updated_html}
      </div>
      {summary_html}
    </header>
  </div>
  <div class="article-layout">
    <article class="prose" data-article data-post-title="{esc(post["title"])}">{post["html"]}</article>
    {toc_html}
  </div>
  <footer class="article-foot">
    <div class="chip-row">{_tag_chips(post["tags"], root)}</div>
    {nav_html}
  </footer>
  {post_interact_block(post_slug=post["slug"], post_title=post["title"], root=root, login_next=post["url"])}
</div>"""


# ---------- 项目列表 ----------

def projects_page(*, config: dict, projects: list, root: str = "") -> str:
    has_featured = any(project["featured"] for project in projects)
    featured_list = [p for p in projects if p["featured"]] if has_featured else []
    normal_list = [p for p in projects if not p["featured"]] if has_featured else projects

    if featured_list:
        featured_block = f"""<section class="section" style="margin-top:44px">
    <div class="section__head"><h2 class="section__title">精选</h2></div>
    <div class="project-grid">{"".join(_project_card(p, root) for p in featured_list)}</div>
  </section>"""
    else:
        featured_block = ""

    normal_head = (
        '<div class="section__head"><h2 class="section__title">全部项目</h2></div>' if featured_list else ""
    )
    if normal_list:
        normal_body = f'<div class="project-grid">{"".join(_project_card(p, root) for p in normal_list)}</div>'
    else:
        normal_body = '<div class="empty-state">还没有项目，去 content/projects/ 里新建一个 .md 文件吧。</div>'
    normal_top = "56px" if featured_list else "44px"

    return f"""<div class="wrap">
  <div class="page-head">
    <span class="eyebrow">Projects</span>
    <h1 class="article-head__title" style="margin-top:14px">项目作品</h1>
    <p class="article-head__summary" style="margin-top:18px">{len(projects)} 个已归档的项目。每个都附了源码或在线演示的入口，欢迎交流。</p>
  </div>
  {featured_block}
  <section class="section" style="margin-top:{normal_top}">
    {normal_head}
    {normal_body}
  </section>
</div>"""


# ---------- 项目详情 ----------

def project_detail_page(*, config: dict, project: dict, root: str = "../") -> str:
    links = "".join(
        f'<a class="btn btn--ghost" href="{esc(link["url"])}" target="_blank" rel="noopener noreferrer">'
        f'{icons.get(link["kind"]) or icons["link"]}<span>{esc(link["label"])}</span></a>'
        for link in project["links"]
    )

    status_badge = (
        f' <span class="status-badge" data-status="{esc(project["status"])}">{esc(project["status"])}</span>'
        if project.get("status")
        else ""
    )
    stack_block = (
        '<div class="chip-row" style="margin-top:22px">'
        + "".join(f'<span class="chip">{esc(item)}</span>' for item in project["stack"])
        + "</div>"
        if project["stack"]
        else ""
    )
    links_block = f'<div class="hero__actions" style="margin-top:24px">{links}</div>' if links else ""

    return f"""<div class="wrap">
  <div class="page-head">
    <nav class="breadcrumb" aria-label="面包屑">
      <a href="{root}index.html">首页</a>
      <span class="breadcrumb__sep">/</span>
      <a href="{root}projects.html">项目</a>
      <span class="breadcrumb__sep">/</span>
      <span>{esc(project["title"])}</span>
    </nav>
    <header class="article-head project-detail__head">
      <span class="eyebrow">Project</span>
      <h1 class="article-head__title">{esc(project["title"])}{status_badge}</h1>
      <p class="article-head__summary">{esc(project["description"])}</p>
      {stack_block}
      {links_block}
    </header>
  </div>
  <article class="prose" data-post-title="{esc(project["title"])}">{project["html"]}</article>
</div>"""


# ---------- 关于页 ----------

def about_page(*, config: dict, page, root: str = "") -> str:
    about = config.get("about") or {}
    initial = esc(str(config.get("author") or config.get("title") or "A").strip()[:1].upper())

    if about.get("skills"):
        skills = f"""<section class="section">
  <div class="section__head"><h2 class="section__title">技能栈</h2></div>
  <div class="skill-list">{"".join(f'<span class="skill-item">{esc(s)}</span>' for s in about["skills"])}</div>
</section>"""
    else:
        skills = ""

    if about.get("timeline"):
        items = "".join(
            f'<li class="timeline__item"><div class="timeline__period">{esc(t.get("period"))}</div>'
            f'<div class="timeline__title">{esc(t.get("title"))}</div>'
            f'<p class="timeline__desc">{esc(t.get("desc"))}</p></li>'
            for t in about["timeline"]
        )
        timeline = f"""<section class="section">
  <div class="section__head"><h2 class="section__title">经历</h2></div>
  <ul class="timeline">{items}</ul>
</section>"""
    else:
        timeline = ""

    social_parts = []
    for item in config.get("social") or []:
        attrs = ' target="_blank" rel="noopener noreferrer"' if _is_http(item.get("url")) else ""
        social_parts.append(
            f'<a class="btn btn--ghost" href="{esc(item.get("url"))}"{attrs}>'
            f'{icons.get(item.get("icon")) or icons["link"]}<span>{esc(item.get("label"))}</span></a>'
        )
    social = "".join(social_parts)
    social_block = (
        '<section class="section"><div class="section__head"><h2 class="section__title">找到我</h2></div>'
        f'<div class="hero__actions" style="margin-top:0">{social}</div></section>'
        if social
        else ""
    )

    page_html = page["html"] if page else "<p>还没有写自我介绍。编辑 <code>content/pages/about.md</code> 即可。</p>"

    return f"""<div class="wrap">
  <div class="about-hero">
    <div>
      <span class="eyebrow">About</span>
      <h1 class="about-hero__name">{esc(config.get("author") or config.get("title"))}</h1>
      <div class="about-hero__role">{esc(config.get("jobTitle") or "")}</div>
      <p class="hero__intro" style="margin-top:18px">{esc(config.get("description") or "")}</p>
    </div>
    <div class="about-hero__avatar">{initial}</div>
  </div>
  <article class="prose">{page_html}</article>
  {skills}
  {timeline}
  {social_block}
</div>"""


# ---------- 标签总览 ----------

def tags_page(*, config: dict, tags: list, posts: list, root: str = "") -> str:
    cloud = "".join(
        f'<a class="tag-card" href="{root}tags/{tag["slug"]}.html"><span>{esc(tag["name"])}</span>'
        f'<span class="tag-card__count">{tag["count"]}</span></a>'
        for tag in tags
    )
    body = cloud or '<div class="empty-state">还没有标签。</div>'

    return f"""<div class="wrap">
  <div class="page-head">
    <span class="eyebrow">Tags</span>
    <h1 class="article-head__title" style="margin-top:14px">标签</h1>
    <p class="article-head__summary" style="margin-top:18px">共 {len(tags)} 个标签，覆盖 {len(posts)} 篇文章。</p>
  </div>
  <section class="section">
    <div class="tag-cloud">{body}</div>
  </section>
</div>"""


def tag_page(*, config: dict, tag: dict, posts: list, root: str = "../../") -> str:
    post_list = "\n    ".join(_post_item(post, root, config) for post in posts)

    return f"""<div class="wrap">
  <div class="page-head">
    <nav class="breadcrumb" aria-label="面包屑">
      <a href="{root}index.html">首页</a>
      <span class="breadcrumb__sep">/</span>
      <a href="{root}tags.html">标签</a>
      <span class="breadcrumb__sep">/</span>
      <span>{esc(tag["name"])}</span>
    </nav>
    <span class="eyebrow">Tag</span>
    <h1 class="article-head__title" style="margin-top:14px">{esc(tag["name"])}</h1>
    <p class="article-head__summary" style="margin-top:18px">该标签下共 {len(posts)} 篇文章。</p>
  </div>
  <section class="section" style="margin-top:44px">
    <ul class="post-list">{post_list}</ul>
  </section>
</div>"""


# ---------- 404 ----------

def not_found_page(*, root: str = "") -> str:
    return f"""<div class="wrap" style="padding:110px 0;text-align:center">
  <div class="mono" style="font-size:4.2rem;font-weight:700;line-height:1;background:linear-gradient(120deg,#2dd4bf,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent">404</div>
  <h1 style="font-size:1.3rem;margin:20px 0 10px">这个页面不存在</h1>
  <p style="color:var(--text-dim);font-size:.92rem;margin:0 0 30px">链接可能已经失效，或者内容被移动了。</p>
  <a class="btn btn--primary" href="{root}index.html">返回首页</a>
</div>"""


# ---------- 登录 / 注册 ----------

_LOGIN_ICONS = {
    "heart": (
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M12 20s-7-4.6-7-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7 2.7C19 15.4 12 20 12 20Z"/></svg>'
    ),
    "bookmark": (
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M6 4.5h12v15l-6-4-6 4z"/></svg>'
    ),
    "comment": (
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M20 12a7.5 7.5 0 0 1-11 6.5L5 20l1.5-4A7.5 7.5 0 1 1 20 12Z"/></svg>'
    ),
    "shield": (
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M12 3l7 3v6c0 4.2-3 7.5-7 9-4-1.5-7-4.8-7-9V6z"/><path d="m9.5 12 1.8 1.8 3.7-3.8"/></svg>'
    ),
    "user": (
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1-3.5 3.7-5.2 7-5.2s6 1.7 7 5.2"/></svg>'
    ),
}


def post_interact_block(*, post_slug: str, post_title: str, root: str = "../", login_next: str = "") -> str:
    """文章页的点赞 / 收藏 / 评论区。

    ``data-post-slug`` 写在容器上，interact.js 启动时直接读取并初始化。
    """
    target = login_next or post_slug
    login_href = f'{root}login.html?next={quote("/" + target, safe="/")}'

    return f"""<section class="interact" data-interact data-post-slug="{esc(post_slug)}" data-post-title="{esc(post_title)}">
  <div class="interact__bar">
    <button class="interact__btn" type="button" data-like aria-pressed="false">
      {_LOGIN_ICONS["heart"]}<span>点赞</span><span class="interact__count" data-like-count>0</span>
    </button>
    <button class="interact__btn" type="button" data-bookmark aria-pressed="false">
      {_LOGIN_ICONS["bookmark"]}<span data-bookmark-label>收藏</span>
    </button>
  </div>
  <div class="comments">
    <div class="comments__head">
      <h2 class="comments__title">{_LOGIN_ICONS["comment"]}<span>评论</span></h2>
      <span class="comments__count"><span data-comment-count>0</span> 条</span>
    </div>
    <div class="comment-gate" data-comment-gate>
      <p>登录后可以参与讨论。</p>
      <a class="btn btn--primary btn--sm" href="{login_href}">登录 / 注册</a>
    </div>
    <form class="comment-form" data-comment-form hidden>
      <textarea class="comment-form__input" data-comment-input rows="3" maxlength="1000" placeholder="写下你的看法…"></textarea>
      <div class="comment-form__foot">
        <span class="comment-form__hint">最多 1000 字</span>
        <button class="btn btn--primary btn--sm" type="submit" data-comment-submit>发表评论</button>
      </div>
    </form>
    <ul class="comment-list" data-comment-list></ul>
  </div>
</section>"""


def login_page(*, config: dict, root: str = "") -> str:
    """登录 / 注册页。双身份选择 + 密码 / 邮箱验证码两种方式。

    DOM 上的 data-* 契约由 ``src/scripts/auth.js`` 使用，改动需同步。
    """
    site_title = esc(config.get("title") or "Blog")
    return f"""<div class="wrap auth-page">
  <div class="auth-card">
    <aside class="auth-card__aside">
      <span class="eyebrow">Account</span>
      <h2 class="auth-aside__title">一个账号，<br>两种身份</h2>
      <p class="auth-aside__text">
        普通用户可以评论、点赞、收藏文章；管理员在同一个账号里多一层权限，可以进入后台在线发文、
        管理评论与用户。
      </p>
      <ul class="auth-aside__list">
        <li>{_LOGIN_ICONS["user"]}<div><strong>普通用户</strong><span>评论 · 点赞 · 收藏 · 个人资料</span></div></li>
        <li>{_LOGIN_ICONS["shield"]}<div><strong>管理员</strong><span>在线发文 · 评论审核 · 用户管理</span></div></li>
      </ul>
      <p class="auth-aside__foot">管理员身份由邮箱白名单认定，普通账号选择管理员身份会被拒绝。</p>
    </aside>

    <div class="auth-card__main">
      <div data-auth-form-wrap>
        <h1 class="auth-card__title" data-auth-title>登录 / 注册</h1>
        <p class="auth-card__lead" data-auth-lead>邮箱 + 密码登录；没有账号的话，首次登录会自动创建。</p>

        <div class="role-switch" role="radiogroup" aria-label="登录身份">
          <button class="role-btn is-active" type="button" role="radio" aria-checked="true" data-role="user">
            <span class="role-btn__icon">{_LOGIN_ICONS["user"]}</span>
            <span class="role-btn__label">普通用户</span>
            <span class="role-btn__desc">参与互动</span>
          </button>
          <button class="role-btn" type="button" role="radio" aria-checked="false" data-role="admin">
            <span class="role-btn__icon">{_LOGIN_ICONS["shield"]}</span>
            <span class="role-btn__label">管理员</span>
            <span class="role-btn__desc">进入后台</span>
          </button>
        </div>

        <form class="auth-form" data-auth-form novalidate>
          <label class="field">
            <span class="field__label">邮箱</span>
            <input class="field__input" type="email" name="email" placeholder="you@example.com"
                   autocomplete="email" spellcheck="false" required>
          </label>

          <div class="auth-tabs" role="tablist" aria-label="登录方式">
            <button class="auth-tab is-active" type="button" role="tab" aria-selected="true" data-tab="password">密码登录</button>
            <button class="auth-tab" type="button" role="tab" aria-selected="false" data-tab="otp">邮箱验证码</button>
          </div>

          <div class="auth-panel" data-panel="password">
            <label class="field">
              <span class="field__label">密码</span>
              <input class="field__input" type="password" name="password" placeholder="输入密码"
                     autocomplete="current-password">
            </label>
          </div>

          <div class="auth-panel" data-panel="otp" hidden>
            <label class="field">
              <span class="field__label">验证码</span>
              <div class="field__row">
                <input class="field__input" type="text" name="code" inputmode="numeric" placeholder="6 位验证码"
                       autocomplete="one-time-code">
                <button class="btn btn--ghost btn--sm" type="button" data-send-code>获取验证码</button>
              </div>
            </label>
            <label class="field">
              <span class="field__label">设置密码（仅新用户需要）</span>
              <input class="field__input" type="password" name="signupPassword" placeholder="新账号首次登录请设置密码"
                     autocomplete="new-password">
            </label>
          </div>

          <div class="auth-error" data-auth-error hidden></div>
          <div class="auth-notice" data-auth-notice hidden></div>

          <button class="btn btn--primary btn--block" type="submit" data-auth-submit>登录</button>
        </form>

        <p class="auth-foot">
          登录即表示你同意本站以最小必要范围保存账号信息。忘记密码可改用「邮箱验证码」登录。
        </p>
      </div>

      <div data-signed-in hidden>
        <h1 class="auth-card__title">你已经登录了</h1>
        <p class="auth-card__lead">可以直接进入个人中心，或者在下方切换身份。</p>
        <div class="signed-card">
          <div class="signed-card__row"><span>账号</span><strong data-signed-in-mail>—</strong></div>
          <div class="signed-card__row"><span>昵称</span><strong data-signed-in-name>—</strong></div>
          <div class="signed-card__row"><span>当前身份</span><strong data-signed-in-role>—</strong></div>
        </div>
        <div class="auth-actions">
          <a class="btn btn--primary" href="{root}account.html">进入个人中心</a>
          <a class="btn btn--ghost" href="{root}admin.html" data-signed-in-admin hidden>管理后台</a>
          <button class="btn btn--ghost" type="button" data-signed-in-switch hidden>切换身份</button>
          <button class="btn btn--danger" type="button" data-signed-in-signout>退出登录</button>
        </div>
      </div>
    </div>
  </div>
</div>"""


# ---------- 个人中心 ----------

def account_page(*, config: dict, root: str = "") -> str:
    return f"""<div class="wrap" data-account>
  <div class="page-head">
    <span class="eyebrow">Account</span>
    <h1 class="article-head__title" style="margin-top:14px">个人中心</h1>
    <p class="article-head__summary" style="margin-top:18px">维护你的资料，查看发表过的评论与收藏的文章。</p>
  </div>

  <div class="account-grid">
    <aside class="account-side">
      <div class="account-card">
        <div class="account-avatar" data-profile-avatar-preview>?</div>
        <div class="account-card__name" data-account-name>加载中…</div>
        <p class="account-card__bio" data-account-bio>—</p>
        <dl class="account-meta">
          <div><dt>邮箱</dt><dd data-account-email>—</dd></div>
          <div><dt>身份</dt><dd data-account-role>—</dd></div>
          <div><dt>注册时间</dt><dd data-account-joined>—</dd></div>
        </dl>
        <div class="account-card__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-account-identity hidden>切换身份</button>
          <button class="btn btn--danger btn--sm" type="button" data-account-signout>退出登录</button>
        </div>
      </div>
    </aside>

    <div class="account-main">
      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">资料设置</h2>
          <span class="panel__hint">昵称会显示在你的评论上</span>
        </div>
        <form class="form-grid" onsubmit="return false">
          <label class="field">
            <span class="field__label">昵称</span>
            <input class="field__input" type="text" maxlength="40" placeholder="怎么称呼你" data-profile-nickname>
          </label>
          <label class="field">
            <span class="field__label">头像地址</span>
            <input class="field__input" type="url" maxlength="500" placeholder="https://… 留空则用昵称首字母"
                   data-profile-avatar>
          </label>
          <label class="field field--full">
            <span class="field__label">个人简介</span>
            <textarea class="field__input" rows="3" maxlength="300" placeholder="一两句话介绍自己" data-profile-bio></textarea>
          </label>
          <div class="form-grid__foot">
            <button class="btn btn--primary btn--sm" type="button" data-profile-save>保存资料</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">我的评论</h2>
        </div>
        <ul class="stack" data-my-comments>
          <li class="stack-empty">加载中…</li>
        </ul>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">我的收藏</h2>
        </div>
        <ul class="stack" data-my-bookmarks>
          <li class="stack-empty">加载中…</li>
        </ul>
      </section>
    </div>
  </div>
</div>"""


# ---------- 管理员后台 ----------

def admin_page(*, config: dict, root: str = "") -> str:
    return f"""<div class="wrap" data-admin>
  <div class="page-head">
    <span class="eyebrow">Admin</span>
    <h1 class="article-head__title" style="margin-top:14px">管理后台</h1>
    <p class="article-head__summary" style="margin-top:18px">
      在线撰写与发布文章、管理评论与用户。这里的每一项操作都会经过服务端权限校验，非管理员无法调用。
    </p>
    <div class="hero__actions" style="margin-top:24px">
      <button class="btn btn--ghost btn--sm" type="button" data-admin-refresh>刷新数据</button>
      <a class="btn btn--ghost btn--sm" href="{root}index.html">返回站点</a>
    </div>
  </div>

  <div class="admin-stats">
    <div class="admin-stat"><div class="admin-stat__value" data-stat-users>0</div><div class="admin-stat__label">注册用户</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-comments>0</div><div class="admin-stat__label">评论总数</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-hidden>0</div><div class="admin-stat__label">已隐藏评论</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-likes>0</div><div class="admin-stat__label">点赞总数</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-posts>0</div><div class="admin-stat__label">在线文章</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-drafts>0</div><div class="admin-stat__label">草稿</div></div>
  </div>

  <div class="admin-tabs" role="tablist" aria-label="后台分区">
    <button class="admin-tab is-active" type="button" role="tab" aria-selected="true" data-admin-tab="posts">文章管理</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="comments">评论管理</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="users">用户</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="admins">管理员</button>
  </div>

  <section class="admin-panel" data-admin-panel="posts">
    <div class="admin-split">
      <div class="panel panel--editor">
        <div class="panel__head">
          <h2 class="panel__title" data-editor-title>写一篇新文章</h2>
          <span class="panel__hint">Markdown 语法，支持代码块与提示块</span>
        </div>
        <form class="form-grid" data-post-form onsubmit="return false">
          <label class="field field--full">
            <span class="field__label">标题</span>
            <input class="field__input" type="text" name="title" placeholder="文章标题" maxlength="120">
          </label>
          <label class="field">
            <span class="field__label">Slug（留空自动生成）</span>
            <input class="field__input mono" type="text" name="slug" placeholder="my-first-post">
          </label>
          <label class="field">
            <span class="field__label">标签（逗号分隔）</span>
            <input class="field__input" type="text" name="tags" placeholder="Python, 性能优化">
          </label>
          <label class="field field--full">
            <span class="field__label">摘要</span>
            <input class="field__input" type="text" name="summary" placeholder="一句话说明这篇文章讲了什么" maxlength="200">
          </label>
          <label class="field field--full">
            <span class="field__label">正文（Markdown）</span>
            <textarea class="field__input field__textarea mono" rows="16" name="content_md"
                      placeholder="## 标题&#10;&#10;正文…"></textarea>
          </label>
          <label class="field">
            <span class="field__label">状态</span>
            <select class="field__input" name="status">
              <option value="draft">草稿（不公开）</option>
              <option value="published">已发布</option>
            </select>
          </label>
          <div class="form-grid__foot form-grid__foot--wide">
            <button class="btn btn--primary btn--sm" type="button" data-post-save>保存草稿</button>
            <button class="btn btn--ghost btn--sm" type="button" data-post-publish>保存并发布</button>
            <button class="btn btn--ghost btn--sm" type="button" data-post-preview>预览渲染</button>
            <button class="btn btn--ghost btn--sm" type="button" data-post-reset>清空表单</button>
          </div>
        </form>
        <div class="editor-preview" data-post-preview-box hidden></div>
      </div>

      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">已发布的在线文章</h2>
          <span class="panel__hint">共 <span data-post-count>0</span> 篇</span>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>标题</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody data-admin-posts>
              <tr><td colspan="4" class="admin-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="comments" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">全部评论</h2>
        <div class="chip-row">
          <button class="chip is-active" type="button" data-comment-filter="all">全部</button>
          <button class="chip" type="button" data-comment-filter="visible">显示中</button>
          <button class="chip" type="button" data-comment-filter="hidden">已隐藏</button>
          <span class="panel__hint">共 <span data-comment-total>0</span> 条</span>
        </div>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>作者 / 文章</th><th>内容</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
          <tbody data-admin-comments>
            <tr><td colspan="5" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="users" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">注册用户</h2>
        <span class="panel__hint">只展示已填写资料的账号</span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>昵称 / ID</th><th>简介</th><th>互动</th><th>注册时间</th></tr></thead>
          <tbody data-admin-users>
            <tr><td colspan="4" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="admins" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">管理员白名单</h2>
        <span class="panel__hint">只有名单里的邮箱登录后才能选择管理员身份</span>
      </div>
      <div class="inline-form">
        <input class="field__input" type="email" placeholder="new-admin@example.com" data-admin-email-input>
        <input class="field__input" type="text" placeholder="备注（可选）" data-admin-email-note>
        <button class="btn btn--primary btn--sm" type="button" data-admin-email-add>加入白名单</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>邮箱</th><th>备注</th><th>加入时间</th><th>操作</th></tr></thead>
          <tbody data-admin-emails>
            <tr><td colspan="4" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</div>"""


# ---------- 在线文章（云端）----------

def cloud_posts_page(*, config: dict, root: str = "") -> str:
    return f"""<div class="wrap" data-cloud-posts>
  <div class="page-head">
    <span class="eyebrow">Online</span>
    <h1 class="article-head__title" style="margin-top:14px">在线文章</h1>
    <p class="article-head__summary" style="margin-top:18px">
      由管理员在后台直接发布的内容，共 <span data-cloud-count>0</span> 篇。它们与静态文章一样支持点赞、收藏与评论。
    </p>
  </div>
  <section class="section" style="margin-top:44px">
    <div class="loading-state" data-cloud-status>正在加载文章…</div>
    <ul class="post-list" data-cloud-post-list></ul>
    <div class="empty-state" data-cloud-empty hidden>还没有在线发布的文章。</div>
  </section>
</div>"""


def cloud_post_page(*, config: dict, root: str = "") -> str:
    return f"""<div class="wrap" data-cloud-post>
  <div class="page-head">
    <nav class="breadcrumb" aria-label="面包屑">
      <a href="{root}index.html">首页</a>
      <span class="breadcrumb__sep">/</span>
      <a href="{root}posts.html">在线文章</a>
    </nav>
    <header class="article-head" data-cloud-head>
      <span class="eyebrow">Online</span>
      <h1 class="article-head__title">加载中…</h1>
    </header>
  </div>
  <article class="prose" data-cloud-body>
    <p>正在读取文章内容…</p>
  </article>
  <section class="interact" data-interact data-post-title="">
    <div class="interact__bar">
      <button class="interact__btn" type="button" data-like aria-pressed="false">
        {_LOGIN_ICONS["heart"]}<span>点赞</span><span class="interact__count" data-like-count>0</span>
      </button>
      <button class="interact__btn" type="button" data-bookmark aria-pressed="false">
        {_LOGIN_ICONS["bookmark"]}<span data-bookmark-label>收藏</span>
      </button>
    </div>
    <div class="comments">
      <div class="comments__head">
        <h2 class="comments__title">{_LOGIN_ICONS["comment"]}<span>评论</span></h2>
        <span class="comments__count"><span data-comment-count>0</span> 条</span>
      </div>
      <div class="comment-gate" data-comment-gate>
        <p>登录后可以参与讨论。</p>
        <a class="btn btn--primary btn--sm" href="{root}login.html?next=/posts.html">登录 / 注册</a>
      </div>
      <form class="comment-form" data-comment-form hidden>
        <textarea class="comment-form__input" data-comment-input rows="3" maxlength="1000" placeholder="写下你的看法…"></textarea>
        <div class="comment-form__foot">
          <span class="comment-form__hint">最多 1000 字</span>
          <button class="btn btn--primary btn--sm" type="submit" data-comment-submit>发表评论</button>
        </div>
      </form>
      <ul class="comment-list" data-comment-list></ul>
    </div>
  </section>
</div>"""
