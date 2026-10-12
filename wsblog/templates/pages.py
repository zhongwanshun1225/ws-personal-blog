"""各页面主体模板。

每个函数只返回 ``<main>`` 内部的 HTML，外层由 ``layout()`` 包裹。
"""

from __future__ import annotations

from ..util import escape_html as esc, parse_date, slugify
from .layout import icons

__all__ = [
    "home_page",
    "post_page",
    "projects_page",
    "project_detail_page",
    "about_page",
    "tags_page",
    "tag_page",
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
