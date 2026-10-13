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
    "related_posts_block",
    "archive_page",
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


# 分享组件用的图标（内联，不额外请求）
_SHARE_ICONS = {
    "link": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.6 6.2"/>'
        '<path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.4-1.4"/></svg>'
    ),
    "weibo": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<ellipse cx="10" cy="15" rx="6.5" ry="4.5"/>'
        '<path d="M16.5 6.5a3.6 3.6 0 0 1 3.6 3.6"/><path d="M16 2.5a7.6 7.6 0 0 1 7.4 7.6"/></svg>'
    ),
    "x": (
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
        '<path d="M17.6 3h3.2l-7 8 7.4 10h-5.8l-4.5-6.2L5.6 21H2.4l7.4-8.4L2.7 3h5.9l4.2 5.8Z"/></svg>'
    ),
    "share": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/>'
        '<circle cx="18" cy="18.5" r="2.6"/>'
        '<path d="M8.4 10.8 15.6 6.8"/><path d="M8.4 13.2l7.2 4"/></svg>'
    ),
}


def share_block(*, label: str = "分享这篇") -> str:
    """文章分享条。

    链接与标题都在点击时由前端取（优先用 <link rel="canonical">，
    这样从 ?q= / ?slug= 这类带参地址进入时分享出去的仍是规范地址）。
    因此这里不需要任何服务端注入的内容，静态页与客户端渲染页可以共用同一份 HTML。
    """
    return f"""<div class="share" data-share aria-label="{esc(label)}">
  <span class="share__label">{_SHARE_ICONS["share"]}<span>{esc(label)}</span></span>
  <div class="share__actions">
    <button class="share__btn" type="button" data-share-action="copy">{_SHARE_ICONS["link"]}<span>复制链接</span></button>
    <a class="share__btn" data-share-action="weibo" href="#" target="_blank" rel="noopener noreferrer">{_SHARE_ICONS["weibo"]}<span>微博</span></a>
    <a class="share__btn" data-share-action="x" href="#" target="_blank" rel="noopener noreferrer">{_SHARE_ICONS["x"]}<span>X</span></a>
    <button class="share__btn" type="button" data-share-action="native" hidden>{_SHARE_ICONS["share"]}<span>更多</span></button>
  </div>
</div>"""


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

def home_page(
    *,
    config: dict,
    posts: list,
    projects: list,
    tags: list,
    root: str = "",
    total_posts: int | None = None,
) -> str:
    """首页。posts 是按「首页展示条数」截断后的列表，total_posts 是文章总数。"""
    hero = config.get("hero") or {}
    total_count = total_posts if total_posts is not None else len(posts)

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
        f'<span class="chip__count">{total_count}</span></button>'
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
    hidden_count = max(0, total_count - len(posts))
    more_block = (
        f'<div class="list-more"><a class="btn btn--ghost" href="{root}archive.html">'
        f"查看全部 {total_count} 篇文章 →</a></div>"
        if hidden_count > 0
        else ""
    )

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
    <a class="section__more" href="{root}archive.html">全部 {total_count} 篇 →</a>
  </div>
  <div class="toolbar">
    <span class="toolbar__label">Filter</span>
    <div class="chip-row" data-filter-row>{filter_chips}</div>
  </div>
  <ul class="post-list" data-post-list>
    {post_list}
  </ul>
  <div class="empty-state" data-empty-state hidden>没有匹配这个标签的文章。</div>
  {more_block}
</section>

{projects_block}
"""


# ---------- 分页 ----------

def page_url(base: str, page: int) -> str:
    """分页 URL：第 1 页就是 base 本身，第 N 页是 base-N.html。

    用「真文件」而不是 ?page=N，是为了让爬虫能逐页收录、也方便静态托管。
    """
    if page <= 1:
        return base
    stem = base[:-5] if base.endswith(".html") else base
    return f"{stem}-{page}.html"


def pagination(*, base: str, page: int, total_pages: int, root: str = "") -> str:
    """上一页 / 页码 / 下一页。单页时不渲染。"""
    if total_pages <= 1:
        return ""

    parts = []
    if page > 1:
        parts.append(
            f'<a class="pagination__link" rel="prev" href="{root}{page_url(base, page - 1)}">← 上一页</a>'
        )
    else:
        parts.append('<span class="pagination__link is-disabled">← 上一页</span>')

    numbers: list = []
    for n in range(1, total_pages + 1):
        if n == 1 or n == total_pages or abs(n - page) <= 2:
            numbers.append(n)
        elif numbers and numbers[-1] != "…":
            numbers.append("…")

    for n in numbers:
        if n == "…":
            parts.append('<span class="pagination__gap">…</span>')
        elif n == page:
            parts.append(
                f'<span class="pagination__link is-current" aria-current="page">{n}</span>'
            )
        else:
            parts.append(f'<a class="pagination__link" href="{root}{page_url(base, n)}">{n}</a>')

    if page < total_pages:
        parts.append(
            f'<a class="pagination__link" rel="next" href="{root}{page_url(base, page + 1)}">下一页 →</a>'
        )
    else:
        parts.append('<span class="pagination__link is-disabled">下一页 →</span>')

    return f'<nav class="pagination" aria-label="分页导航">{"".join(parts)}</nav>'


def paginate(items: list, per_page: int) -> tuple[list[list], int]:
    """把列表切成每页 per_page 条。per_page <= 0 表示不分页。"""
    if not per_page or per_page <= 0 or len(items) <= per_page:
        return [list(items)], 1
    chunks = [items[i : i + per_page] for i in range(0, len(items), per_page)]
    return chunks, len(chunks)


# ---------- 文章详情 ----------

def post_page(*, config: dict, post: dict, prev_post, next_post, related=None, root: str = "../", interact_slug: str = "") -> str:
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
    related_html = related_posts_block(posts=related, root=root) if related else ""

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
    {share_block()}
    {nav_html}
    {related_html}
  </footer>
  {post_interact_block(post_slug=(interact_slug or post["slug"]), post_title=post["title"], root=root, login_next=post["url"])}
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

def related_posts_block(*, posts: list, root: str = "../") -> str:
    """文章详情页底部的「相关文章」。posts 由构建期按标签相似度算好。"""
    if not posts:
        return ""
    items = "\n    ".join(
        f'<a class="related-item" href="{root}{post["url"]}">'
        f'<span class="related-item__title">{esc(post["title"])}</span>'
        f'<span class="related-item__meta">{_short_date(post["date"])}</span></a>'
        for post in posts
    )
    return f"""<section class="related">
  <h2 class="related__title">相关文章</h2>
  <div class="related__list">{items}</div>
</section>"""


def archive_page(
    *,
    config: dict,
    posts: list,
    root: str = "",
    page: int = 1,
    total_pages: int = 1,
    total: int | None = None,
) -> str:
    """归档页：按年分组的时间轴列表。支持分页（archive.html / archive-2.html …）。"""
    years: dict[str, list] = {}
    for post in posts:
        local = post["date"].astimezone()
        years.setdefault(str(local.year), []).append(post)
    year_names = sorted(years, reverse=True)

    year_blocks = []
    for year in year_names:
        items = "\n    ".join(
            f'<a class="archive-item" href="{root}{post["url"]}">'
            f'<span class="archive-item__date">{_short_date(post["date"])}</span>'
            f'<span class="archive-item__title">{esc(post["title"])}</span>'
            f'<span class="archive-item__read">{post.get("reading_time", "")} 分钟</span></a>'
            for post in years[year]
        )
        year_blocks.append(
            f'<section class="archive-year">\n'
            f'  <h2 class="archive-year__title">{esc(year)} <span>{len(years[year])} 篇</span></h2>\n'
            f'  <div class="archive-list">\n    {items}\n  </div>\n'
            f"</section>"
        )
    body = "\n".join(year_blocks) or '<div class="empty-state">还没有文章。</div>'
    total_count = total if total is not None else len(posts)

    page_note = (
        f'<span class="breadcrumb__sep">/</span><span>第 {page} 页</span>' if page > 1 else ""
    )
    summary = f"共 {total_count} 篇文章，按发布时间归档。"
    if total_pages > 1:
        summary += f" 当前第 {page} / {total_pages} 页。"

    return f"""<div class="wrap">
  <div class="page-head">
    <nav class="breadcrumb" aria-label="面包屑">
      <a href="{root}index.html">首页</a>
      <span class="breadcrumb__sep">/</span>
      <a href="{root}archive.html">归档</a>
      {page_note}
    </nav>
    <span class="eyebrow">Archive</span>
    <h1 class="article-head__title" style="margin-top:14px">归档</h1>
    <p class="article-head__summary" style="margin-top:18px">{summary}</p>
  </div>
  <div class="archive">{body}</div>
  {pagination(base="archive.html", page=page, total_pages=total_pages, root=root)}
</div>"""


def offline_page(*, config: dict, root: str = "") -> str:
    """离线兜底页：Service Worker 在断网且无缓存时展示。"""
    return f"""<div class="wrap" style="padding:110px 0;text-align:center">
  <div class="mono" style="font-size:4.2rem;font-weight:700;line-height:1;background:linear-gradient(120deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent">OFFLINE</div>
  <h1 style="font-size:1.3rem;margin:20px 0 10px">当前没有网络连接</h1>
  <p style="color:var(--text-dim);font-size:.92rem;margin:0 auto 30px;max-width:460px">
    这个页面还没有被缓存。恢复网络后刷新即可；已浏览过的页面在离线状态下仍然可以打开。
  </p>
  <a class="btn btn--primary" href="{root}index.html">重试首页</a>
</div>"""


def not_found_page(*, root: str = "", posts: list | None = None, tags: list | None = None) -> str:
    """404：给访客留出路 —— 搜索、最新文章、热门标签。

    传统站点的 404 都会做「补救导航」，否则访客从搜索引擎落到一个死链后只能离开。
    """
    posts = posts or []
    tags = tags or []
    latest = posts[:6]

    latest_items = "\n      ".join(
        f'<li class="post-item"><div class="post-item__link">'
        f'<div class="post-item__date">{_short_date(post["date"])}</div>'
        f'<div class="post-item__main">'
        f'<h3 class="post-item__title"><a class="stretch-link" href="{root}{post["url"]}">'
        f'{esc(post["title"])}</a></h3>'
        f'<p class="post-item__summary">{esc(post["summary"])}</p>'
        f"</div></div></li>"
        for post in latest
    )
    latest_block = (
        f"""<section class="section" style="margin-top:56px">
    <div class="section__head"><h2 class="section__title">最新文章</h2>
      <a class="section__more" href="{root}archive.html">全部文章 →</a></div>
    <ul class="post-list">
      {latest_items}
    </ul>
  </section>"""
        if latest
        else ""
    )

    tag_chips = "".join(
        f'<a class="chip" href="{root}tags/{tag["slug"]}.html">{esc(tag["name"])}'
        f'<span class="chip__count">{tag["count"]}</span></a>'
        for tag in tags[:10]
    )
    tags_block = (
        f"""<section class="section" style="margin-top:44px">
    <div class="section__head"><h2 class="section__title">按标签找</h2>
      <a class="section__more" href="{root}tags.html">全部标签 →</a></div>
    <div class="chip-row">{tag_chips}</div>
  </section>"""
        if tag_chips
        else ""
    )

    return f"""<div class="wrap not-found">
  <div class="not-found__head">
    <div class="not-found__code mono">404</div>
    <h1 class="not-found__title">这个页面不存在</h1>
    <p class="not-found__desc">链接可能已经失效，或者内容被移动了。试试搜索，或者从下面继续浏览。</p>
    <div class="hero__actions">
      <button class="btn btn--primary" type="button" data-search-open>搜索站内内容</button>
      <a class="btn btn--ghost" href="{root}index.html">返回首页</a>
    </div>
  </div>
  {latest_block}
  {tags_block}
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
    "eye": (
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/>'
        '<circle cx="12" cy="12" r="3"/></svg>'
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
    <span class="interact__views">
      {_LOGIN_ICONS["eye"]}<span data-views-count>0</span> 次阅读
    </span>
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
      <div class="comment-form__target" data-reply-bar hidden>
        正在回复 <strong data-reply-name></strong>
        <button class="comment-form__cancel" type="button" data-reply-cancel>取消</button>
      </div>
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
    """登录 / 注册页。单一入口（不预选身份）+ 密码 / 邮箱验证码两种方式。

    管理员账号登录成功后，会多出一步「选择进入身份」（普通用户 / 管理后台）。
    DOM 上的 data-* 契约由 ``src/scripts/auth.js`` 使用，改动需同步。
    """
    site_title = esc(config.get("title") or "Blog")
    return f"""<div class="wrap auth-page">
  <div class="auth-card">
    <aside class="auth-card__aside">
      <span class="eyebrow">Account</span>
      <h2 class="auth-aside__title">一个入口，<br>权限自动生效</h2>
      <p class="auth-aside__text">
        所有人用同一个入口登录：填邮箱和密码就行，没有账号的话首次登录会自动创建。
        能做什么由账号本身决定，不需要提前选入口。
      </p>
      <ul class="auth-aside__list">
        <li>{_LOGIN_ICONS["user"]}<div><strong>普通账号</strong><span>评论 · 点赞 · 收藏 · 个人资料</span></div></li>
        <li>{_LOGIN_ICONS["shield"]}<div><strong>管理员账号</strong><span>登录后可自选：以普通用户浏览，或进入后台</span></div></li>
      </ul>
      <p class="auth-aside__foot">管理员由邮箱白名单认定，登录后才会出现身份选择。</p>
    </aside>

    <div class="auth-card__main">
      <div data-auth-form-wrap>
        <h1 class="auth-card__title" data-auth-title>登录 / 注册</h1>
        <p class="auth-card__lead" data-auth-lead>邮箱 + 密码登录；没有账号的话，首次登录会自动创建。</p>

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
          登录即表示你同意本站以最小必要范围保存账号信息。
          <button class="link-btn" type="button" data-auth-forgot>忘记密码？</button>
        </p>
      </div>

      <div data-reset-wrap hidden>
        <h1 class="auth-card__title">重置密码</h1>
        <p class="auth-card__lead">填写注册邮箱获取验证码，验证通过后直接设置新密码并登录。</p>

        <form class="auth-form" data-reset-form novalidate>
          <label class="field">
            <span class="field__label">邮箱</span>
            <input class="field__input" type="email" name="resetEmail" placeholder="you@example.com"
                   autocomplete="email" spellcheck="false" required>
          </label>

          <label class="field">
            <span class="field__label">验证码</span>
            <div class="field__row">
              <input class="field__input" type="text" name="resetCode" inputmode="numeric"
                     placeholder="邮件里的验证码" autocomplete="one-time-code">
              <button class="btn btn--ghost btn--sm" type="button" data-reset-send>获取验证码</button>
            </div>
          </label>

          <label class="field">
            <span class="field__label">新密码</span>
            <input class="field__input" type="password" name="resetPassword" placeholder="至少 6 位"
                   autocomplete="new-password">
          </label>

          <label class="field">
            <span class="field__label">确认新密码</span>
            <input class="field__input" type="password" name="resetPassword2" placeholder="再输入一次"
                   autocomplete="new-password">
          </label>

          <div class="auth-error" data-reset-error hidden></div>
          <div class="auth-notice" data-reset-notice hidden></div>

          <button class="btn btn--primary btn--block" type="submit" data-reset-submit>重置密码并登录</button>
        </form>

        <p class="auth-foot">
          <button class="link-btn" type="button" data-reset-back>← 返回登录</button>
        </p>
      </div>

      <div data-identity-pick hidden>
        <h1 class="auth-card__title">选择进入身份</h1>
        <p class="auth-card__lead">
          <strong data-pick-email>—</strong> 属于管理员账号，请选择这次要以什么身份进入。
        </p>

        <div class="role-switch">
          <button class="role-btn" type="button" data-pick="user">
            <span class="role-btn__icon">{_LOGIN_ICONS["user"]}</span>
            <span class="role-btn__label">以普通用户身份进入</span>
            <span class="role-btn__desc">前台浏览，评论 · 点赞 · 收藏</span>
          </button>
          <button class="role-btn" type="button" data-pick="admin">
            <span class="role-btn__icon">{_LOGIN_ICONS["shield"]}</span>
            <span class="role-btn__label">进入后台管理</span>
            <span class="role-btn__desc">在线发文 · 评论审核 · 用户管理</span>
          </button>
        </div>

        <p class="auth-foot">
          之后随时可以在右上角账号菜单里切换身份。
          <button class="link-btn" type="button" data-pick-signout>退出登录</button>
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
          <div class="field">
            <span class="field__label">头像地址（可直接上传）</span>
            <div class="field__row">
              <input class="field__input" type="url" maxlength="500" placeholder="https://… 留空则用昵称首字母"
                     data-profile-avatar>
              <button class="btn btn--ghost btn--sm" type="button" data-avatar-upload>上传头像</button>
            </div>
          </div>
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
          <h2 class="panel__title">我的投稿</h2>
          <span class="panel__hint">
            共 <span data-my-post-count>0</span> 篇 · <a href="{root}write.html">写新文章</a>
          </span>
        </div>
        <ul class="stack" data-my-posts>
          <li class="stack-empty">加载中…</li>
        </ul>
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


# ---------- 通知中心 ----------

def notifications_page(*, config: dict, root: str = "") -> str:
    return f"""<div class="wrap" data-notify-page>
  <nav class="breadcrumb" aria-label="面包屑">
    <a href="{root}index.html">首页</a><span class="breadcrumb__sep">/</span><span aria-current="page">通知</span>
  </nav>
  <div class="page-head">
    <span class="eyebrow">Notifications</span>
    <h1 class="article-head__title" style="margin-top:14px">通知中心</h1>
    <p class="article-head__summary" style="margin-top:18px">
      有人回复你的评论、评论你的文章，或者你的投稿有了审核结果，都会出现在这里。<span data-notify-summary></span>
    </p>
    <div class="hero__actions" style="margin-top:24px">
      <button class="btn btn--ghost btn--sm" type="button" data-notify-read-all>全部标为已读</button>
      <button class="btn btn--ghost btn--sm" type="button" data-notify-clear>清空通知</button>
    </div>
  </div>

  <div class="panel">
    <div class="panel__head">
      <h2 class="panel__title">通知列表</h2>
      <div class="chip-row">
        <button class="chip is-active" type="button" data-notify-filter="all">全部</button>
        <button class="chip" type="button" data-notify-filter="unread">未读
          <span class="chip__count" data-notify-unread-chip>0</span></button>
      </div>
    </div>
    <ul class="notif-list" data-notify-list>
      <li class="notif-empty">加载中…</li>
    </ul>
    <div class="notif-gate" data-notify-gate hidden>
      <p>登录后才能查看通知。</p>
      <a class="btn btn--primary btn--sm" href="{root}login.html">登录 / 注册</a>
    </div>
    <div class="notif-foot">
      <button class="btn btn--ghost btn--sm" type="button" data-notify-more hidden>加载更多</button>
    </div>
  </div>
</div>"""


# ---------- 用户投稿 ----------

def write_page(*, config: dict, root: str = "") -> str:
    return f"""<div class="wrap" data-write>
  <div class="page-head">
    <span class="eyebrow">Write</span>
    <h1 class="article-head__title" style="margin-top:14px">写篇文章</h1>
    <p class="article-head__summary" style="margin-top:18px">
      用 Markdown 分享你的技术沉淀。保存草稿只有你自己可见；提交审核后由站长确认，通过即全站可见。
    </p>
  </div>

  <div class="write-note" data-write-note hidden></div>

  <div class="draft-banner" data-draft-banner hidden>
    <div class="draft-banner__text" data-draft-banner-text></div>
    <div class="draft-banner__actions">
      <button class="btn btn--primary btn--sm" type="button" data-draft-restore>恢复本地草稿</button>
      <button class="btn btn--ghost btn--sm" type="button" data-draft-discard>丢弃</button>
    </div>
  </div>

  <div class="admin-split write-split">
    <div class="panel panel--editor">
      <div class="panel__head">
        <h2 class="panel__title" data-editor-title>新建投稿</h2>
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
          <textarea class="field__input field__textarea mono" rows="18" name="content_md"
                    placeholder="## 标题&#10;&#10;正文…"></textarea>
        </label>
        <div class="form-grid__foot form-grid__foot--wide">
          <button class="btn btn--ghost btn--sm" type="button" data-post-save>保存草稿</button>
          <button class="btn btn--primary btn--sm" type="button" data-post-submit>提交审核</button>
          <button class="btn btn--ghost btn--sm" type="button" data-post-preview>预览渲染</button>
          <button class="btn btn--ghost btn--sm" type="button" data-post-image>插图</button>
          <button class="btn btn--ghost btn--sm" type="button" data-post-reset>清空表单</button>
          <span class="write-status" data-write-status aria-live="polite"></span>
        </div>
      </form>
      <div class="editor-preview" data-post-preview-box hidden></div>
    </div>

    <aside class="write-side">
      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">我的投稿</h2>
          <span class="panel__hint">共 <span data-my-post-count>0</span> 篇</span>
        </div>
        <ul class="stack" data-my-posts>
          <li class="stack-empty">加载中…</li>
        </ul>
      </div>

      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">投稿须知</h2>
        </div>
        <ul class="write-rules">
          <li>正文会<strong>自动保存在本机</strong>，切页或误关浏览器也不会丢；下次打开发布页可一键恢复。</li>
          <li>提交后进入<strong>待审核</strong>，站长通过之前不会出现在前台。</li>
          <li>未通过的稿件会附上理由，改完可以再次提交。</li>
          <li>已发布的文章不能自行编辑，需要修改请联系站长先下架。</li>
          <li>请勿提交违规、侵权或与本站主题无关的内容。</li>
        </ul>
      </div>
    </aside>
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
    <div class="admin-stat"><div class="admin-stat__value" data-stat-disabled>0</div><div class="admin-stat__label">已禁用账号</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-comments>0</div><div class="admin-stat__label">评论总数</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-today>0</div><div class="admin-stat__label">24h 新评论</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-views>0</div><div class="admin-stat__label">总阅读量</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-hidden>0</div><div class="admin-stat__label">已隐藏评论</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-likes>0</div><div class="admin-stat__label">点赞总数</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-posts>0</div><div class="admin-stat__label">在线文章</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-drafts>0</div><div class="admin-stat__label">草稿</div></div>
    <div class="admin-stat"><div class="admin-stat__value" data-stat-pending>0</div><div class="admin-stat__label">待审核投稿</div></div>
  </div>

  <div class="admin-tabs" role="tablist" aria-label="后台分区">
    <button class="admin-tab is-active" type="button" role="tab" aria-selected="true" data-admin-tab="posts">文章管理</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="review">内容审核 <span class="admin-tab__badge" data-review-badge hidden>0</span></button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="comments">评论管理</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="users">用户</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="admins">管理员</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="audit">操作日志</button>
  </div>

  <section class="admin-panel" data-admin-panel="audit" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">管理操作日志</h2>
        <span class="panel__hint">删帖、删评论、审核、用户封禁、管理员白名单变更等敏感操作的服务端留痕（最近 100 条）</span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
          <tbody data-audit-log>
            <tr><td colspan="5" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="posts">
    <div class="admin-split">
      <div class="panel panel--editor">
        <div class="panel__head">
          <h2 class="panel__title" data-editor-title>写一篇新文章</h2>
          <span class="panel__hint">Markdown 语法，支持代码块与提示块</span>
        </div>
        <div class="draft-banner" data-admin-draft-banner hidden>
          <div class="draft-banner__text" data-admin-draft-text></div>
          <div class="draft-banner__actions">
            <button class="btn btn--primary btn--sm" type="button" data-admin-draft-restore>恢复本地草稿</button>
            <button class="btn btn--ghost btn--sm" type="button" data-admin-draft-discard>丢弃</button>
          </div>
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
            <button class="btn btn--ghost btn--sm" type="button" data-post-image>插图</button>
            <button class="btn btn--ghost btn--sm" type="button" data-post-reset>清空表单</button>
            <span class="write-status" data-admin-status aria-live="polite"></span>
          </div>
        </form>
        <div class="editor-preview" data-post-preview-box hidden></div>
      </div>

      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">全部在线文章</h2>
          <span class="panel__hint">含管理员发布与用户投稿，共 <span data-post-count>0</span> 篇</span>
        </div>
        <div class="admin-toolbar">
          <input class="field__input" type="search" placeholder="搜索标题 / slug / 作者 / 邮箱" data-post-search>
          <select class="field__input field__input--select" data-post-status>
            <option value="all">全部状态</option>
            <option value="pending">待审核</option>
            <option value="published">已发布</option>
            <option value="draft">草稿</option>
            <option value="rejected">未通过</option>
          </select>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>标题</th><th>作者</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody data-admin-posts>
              <tr><td colspan="5" class="admin-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="admin-pager" data-post-pager></div>
      </div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="review" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">待审核投稿</h2>
        <span class="panel__hint">普通用户提交的稿件，通过后才会出现在前台（当前 <span data-review-count>0</span> 篇待处理）</span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>标题</th><th>作者</th><th>提交时间</th><th>篇幅</th><th>操作</th></tr></thead>
          <tbody data-admin-review>
            <tr><td colspan="5" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-review-pager></div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">已处理投稿</h2>
        <span class="panel__hint">最近审核过的稿件，可随时下架或重新通过</span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>标题</th><th>作者</th><th>结果</th><th>审核时间</th><th>操作</th></tr></thead>
          <tbody data-admin-reviewed>
            <tr><td colspan="5" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-reviewed-pager></div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="comments" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">全部评论</h2>
        <span class="panel__hint">共 <span data-comment-total>0</span> 条</span>
      </div>
      <div class="admin-toolbar">
        <input class="field__input" type="search" placeholder="搜索昵称 / 内容 / 文章 slug" data-comment-search>
        <div class="chip-row">
          <button class="chip is-active" type="button" data-comment-filter="all">全部</button>
          <button class="chip" type="button" data-comment-filter="visible">显示中</button>
          <button class="chip" type="button" data-comment-filter="hidden">已隐藏</button>
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
      <div class="admin-pager" data-comment-pager></div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="users" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">用户管理</h2>
        <span class="panel__hint">密码由云平台加密托管（bcrypt），管理员无法查看或篡改；用户可在登录页「忘记密码」自助重置</span>
      </div>
      <div class="admin-toolbar">
        <input class="field__input" type="search" placeholder="搜索昵称 / 邮箱 / 用户 ID" data-user-search>
        <select class="field__input field__input--select" data-user-status>
          <option value="all">全部账号</option>
          <option value="active">正常</option>
          <option value="disabled">已禁用</option>
          <option value="admin">管理员</option>
        </select>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr><th>昵称 / ID</th><th>邮箱</th><th>状态</th><th>角色</th><th>互动</th><th>注册时间</th><th>操作</th></tr>
          </thead>
          <tbody data-admin-users>
            <tr><td colspan="7" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-user-pager></div>
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
    <nav class="breadcrumb" aria-label="面包屑">
      <a href="{root}index.html">首页</a>
      <span class="breadcrumb__sep">/</span>
      <span>在线文章</span>
    </nav>
    <span class="eyebrow">Online</span>
    <h1 class="article-head__title" style="margin-top:14px">在线文章</h1>
    <p class="article-head__summary" style="margin-top:18px">
      站长与投稿用户发布的内容，共 <span data-cloud-count>0</span> 篇。它们与静态文章一样支持点赞、收藏与评论。
    </p>
    <div class="hero__actions" style="margin-top:24px">
      <a class="btn btn--ghost btn--sm" href="{root}write.html">我也要投稿</a>
    </div>
  </div>
  <section class="section" style="margin-top:44px">
    <div class="loading-state" data-cloud-status>正在加载文章…</div>
    <ul class="post-list" data-cloud-post-list></ul>
    <div class="empty-state" data-cloud-empty hidden>还没有在线发布的文章。</div>
    <nav class="pagination" aria-label="分页导航" data-cloud-pagination hidden></nav>
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
  <div class="article-layout">
    <article class="prose" data-cloud-body>
      <p>正在读取文章内容…</p>
    </article>
    <aside class="toc" data-cloud-toc hidden></aside>
  </div>
  <footer class="article-foot">
    {share_block()}
    <div data-cloud-postnav></div>
  </footer>
  <section class="interact" data-interact data-post-title="">
    <div class="interact__bar">
      <button class="interact__btn" type="button" data-like aria-pressed="false">
        {_LOGIN_ICONS["heart"]}<span>点赞</span><span class="interact__count" data-like-count>0</span>
      </button>
      <button class="interact__btn" type="button" data-bookmark aria-pressed="false">
        {_LOGIN_ICONS["bookmark"]}<span data-bookmark-label>收藏</span>
      </button>
      <span class="interact__views">
        {_LOGIN_ICONS["eye"]}<span data-views-count>0</span> 次阅读
      </span>
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
        <div class="comment-form__target" data-reply-bar hidden>
          正在回复 <strong data-reply-name></strong>
          <button class="comment-form__cancel" type="button" data-reply-cancel>取消</button>
        </div>
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
