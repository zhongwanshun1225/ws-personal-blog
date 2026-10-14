"""各页面主体模板。

每个函数只返回 ``<main>`` 内部的 HTML，外层由 ``layout()`` 包裹。
"""

from __future__ import annotations

import json
from urllib.parse import quote

from ..i18n import T, normalize_lang
from ..util import escape_html as esc, parse_date, slugify
from .layout import breadcrumb_nav, i18n_config_attr, icons, lazy_img

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
    "series_index_page",
    "series_page",
    "shortcuts_page",
    "subscribe_page",
    "login_page",
    "account_page",
    "admin_page",
    "cloud_posts_page",
    "cloud_post_page",
    "not_found_page",
]

_WEEKDAYS_CN = ("周日", "周一", "周二", "周三", "周四", "周五", "周六")
_WEEKDAYS_EN = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
_MONTHS_EN = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def _lang(config: dict) -> str:
    """页面的默认渲染语言（取自 site.config.json 的 lang）。"""
    return normalize_lang((config or {}).get("lang"))


def _crumb_home(config: dict):
    """首页那一层的面包屑条目（(标签, 链接, i18n key)）。"""
    return (T("common.home", _lang(config)), "index.html", "common.home")


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


def _full_date(value, lang: str | None = None) -> str:
    """文章头部那种完整日期。中文 ``2026 年 10 月 8 日 · 周四``，英文 ``October 8, 2026 · Thursday``。"""
    parsed = parse_date(value)
    if parsed is None:
        return ""
    local = parsed.astimezone()
    index = (local.weekday() + 1) % 7
    if normalize_lang(lang) == "en":
        return f"{_MONTHS_EN[local.month - 1]} {local.day}, {local.year} · {_WEEKDAYS_EN[index]}"
    return f"{local.year} 年 {local.month} 月 {local.day} 日 · {_WEEKDAYS_CN[index]}"


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


def _metrics(post: dict, lang: str) -> str:
    """列表卡片上的互动数（V15）：阅读 / 点赞 / 评论。

    三个数字都为 0 时整块不输出 —— 零阅读零点赞的「数据展示」只是噪声。
    数字由构建期烘焙（见 wsblog/cloudstats.py），没有 JS 也能看到，
    对爬虫也是可读的社交证明。
    """
    views = int(post.get("views") or 0)
    likes = int(post.get("likes") or 0)
    comments = int(post.get("comment_count") or 0)
    if not (views or likes or comments):
        return ""
    parts = []
    for key, value, label_key in (
        ("views", views, "list.metricViews"),
        ("likes", likes, "list.metricLikes"),
        ("comments", comments, "list.metricComments"),
    ):
        if value:
            parts.append(
                f'<span class="metrics__item" data-metric="{key}">'
                f'<span class="metrics__value">{value}</span>'
                f'<span class="metrics__label" data-i18n="{label_key}">{esc(T(label_key, lang))}</span></span>'
            )
    return f'<span class="metrics">{"".join(parts)}</span>'


def _post_item(post: dict, root: str, config: dict) -> str:
    """文章列表项。

    注意：整个卡片用「拉伸链接」模式（标题里的 a 用 ::before 铺满卡片），
    而不是把 <a> 当卡片容器 —— 因为卡片里的标签也是链接，
    HTML 不允许 <a> 嵌套，嵌套会让解析器拆散外层锚点、破坏布局。
    """
    options = config.get("options") or {}
    lang = _lang(config)
    show_reading = options.get("showReadingTime", True) is not False
    reading = (
        f'<span>{post["reading_time"]} <span data-i18n="common.minutes">{esc(T("common.minutes", lang))}</span></span>'
        if show_reading
        else ""
    )
    pinned = (
        f'<span class="pinned-flag" data-i18n="common.pinned">{esc(T("common.pinned", lang))}</span> '
        if post.get("pinned")
        else ""
    )
    tags_attr = " ".join(slugify(tag) for tag in post["tags"])

    return f"""<li class="post-item" data-tags="{esc(tags_attr)}" data-hot="{int(post.get('hot') or 0)}">
  <div class="post-item__link">
    <div class="post-item__date">{_short_date(post["date"])}{reading}</div>
    <div class="post-item__main">
      <h3 class="post-item__title"><a class="stretch-link" href="{root}{post["url"]}">{pinned}{esc(post["title"])}</a></h3>
      <p class="post-item__summary">{esc(post["summary"])}</p>
      <div class="post-item__meta">{_tag_chips(post["tags"], root)}{_metrics(post, lang)}</div>
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
    activity: dict | None = None,
    series: list | None = None,
) -> str:
    """首页。posts 是按「首页展示条数」截断后的列表，total_posts 是文章总数。

    ``activity``（V6 站点动态）形如 ``{"comments": [...], "posts": [...]}``：
    这两块数据来自构建期拉取的 ``comments_public``（只含可见评论），
    拉不到就整块不渲染 —— 空的「最近评论」比没有更难看。
    """
    hero = config.get("hero") or {}
    lang = _lang(config)
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
        f'<button class="chip is-active" type="button" data-filter="all" data-i18n="common.all">{esc(T("common.all", lang))}'
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
        f'<span data-i18n="home.viewAll">{esc(T("home.viewAll", lang))}</span> {total_count} →</a>'
        f'<a class="btn btn--ghost" href="{root}archive.html?sort=hot" data-sort-link="hot">'
        f'<span data-i18n="list.sortHot">{esc(T("list.sortHot", lang))}</span> →</a></div>'
        if hidden_count > 0
        else ""
    )

    # ---------- 站点动态（V6） ----------
    # 「最近评论」需要构建期拉到可见评论才渲染；「最近更新」用文章自身时间，
    # 两块任意一块有内容就出整个 section。
    activity_rows = []
    for comment in (activity or {}).get("comments") or []:
        author = esc(comment.get("author") or "读者")
        excerpt = esc(comment.get("excerpt") or "")
        link = esc(comment.get("url") or "#")
        activity_rows.append(
            f'<li class="activity__item"><div class="activity__meta">'
            f'<span class="activity__author">{author}</span>'
            f'<span class="activity__date">{_short_date(comment.get("date"))}</span></div>'
            f'<a class="activity__excerpt" href="{root}{link}">{excerpt}</a></li>'
        )
    recent_updates = (activity or {}).get("updated") or []
    update_rows = [
        f'<li class="activity__item"><div class="activity__meta">'
        f'<span class="activity__date">{_short_date(post.get("updated") or post["date"])}</span></div>'
        f'<a class="activity__excerpt" href="{root}{post["url"]}">{esc(post["title"])}</a></li>'
        for post in recent_updates
    ]
    activity_block = ""
    if activity_rows or update_rows:
        comments_col = (
            f'<div class="activity__col">'
            f'<h3 class="activity__title" data-i18n="home.activityComments">{esc(T("home.activityComments", lang))}</h3>'
            f'<ul class="activity__list">{"".join(activity_rows)}</ul></div>'
            if activity_rows
            else ""
        )
        updates_col = (
            f'<div class="activity__col">'
            f'<h3 class="activity__title" data-i18n="home.activityPosts">{esc(T("home.activityPosts", lang))}</h3>'
            f'<ul class="activity__list">{"".join(update_rows)}</ul></div>'
            if update_rows
            else ""
        )
        activity_block = f"""<section class="wrap section" id="activity">
  <div class="section__head">
    <h2 class="section__title" data-i18n="home.activity">{esc(T("home.activity", lang))}</h2>
  </div>
  <div class="activity">{comments_col}{updates_col}</div>
</section>"""

    # ---------- 系列（V7） ----------
    series_block = ""
    if series:
        chips = "".join(
            f'<a class="series-chip" href="{root}series/{esc(item["slug"])}.html">'
            f'<span class="series-chip__name">{esc(item["name"])}</span>'
            f'<span class="series-chip__count">{esc(T("series.count", lang, n=item["count"]))}</span></a>'
            for item in series[:6]
        )
        series_block = f"""<section class="wrap section" id="series">
  <div class="section__head">
    <h2 class="section__title" data-i18n="series.title">{esc(T("series.title", lang))}</h2>
    <a class="section__more" href="{root}series.html"><span data-i18n="home.viewAll">{esc(T("home.viewAll", lang))}</span> →</a>
  </div>
  <div class="series-row">{chips}</div>
</section>"""

    # ---------- 订阅引导（V11 入口） ----------
    subscribe_block = f"""<section class="wrap section" id="subscribe-cta">
  <div class="cta">
    <div>
      <h2 class="cta__title" data-i18n="home.subscribe">{esc(T("home.subscribe", lang))}</h2>
      <p class="cta__desc" data-i18n="home.subscribeHint">{esc(T("home.subscribeHint", lang))}</p>
    </div>
    <div class="cta__actions">
      <a class="btn btn--primary" href="{root}subscribe.html" data-i18n="home.subscribe">{esc(T("home.subscribe", lang))}</a>
      <a class="btn btn--ghost" href="{root}feed.xml">{icons["rss"]}<span>RSS</span></a>
    </div>
  </div>
</section>"""

    featured_projects = projects[:3]
    if featured_projects:
        grid = "".join(_project_card(project, root) for project in featured_projects)
        projects_block = f"""<section class="wrap section" id="projects">
  <div class="section__head">
    <h2 class="section__title" data-i18n="home.projects">{esc(T("home.projects", lang))}</h2>
    <a class="section__more" href="{root}projects.html"><span data-i18n="home.viewAllProjects">{esc(T("home.viewAllProjects", lang))}</span> →</a>
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
    <h2 class="section__title" data-i18n="home.latest">{esc(T("home.latest", lang))}</h2>
    <a class="section__more" href="{root}archive.html"><span data-i18n="home.viewAll">{esc(T("home.viewAll", lang))}</span> {total_count} →</a>
  </div>
  <div class="toolbar">
    <span class="toolbar__label" data-i18n="home.filter">{esc(T("home.filter", lang))}</span>
    <div class="chip-row" data-filter-row>{filter_chips}</div>
  </div>
  <ul class="post-list" data-post-list>
    {post_list}
  </ul>
  <div class="empty-state" data-empty-state hidden data-i18n="home.empty">{esc(T("home.empty", lang))}</div>
  {more_block}
</section>

{activity_block}

{series_block}

{projects_block}

{subscribe_block}
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


def pagination(*, base: str, page: int, total_pages: int, root: str = "", lang: str | None = None) -> str:
    """上一页 / 页码 / 下一页。单页时不渲染。"""
    if total_pages <= 1:
        return ""

    lang = lang or _lang(None)
    prev_text = f'← {esc(T("pagination.prev", lang))}'
    next_text = f'{esc(T("pagination.next", lang))} →'
    nav_label = esc(T("pagination.nav", lang))

    parts = []
    if page > 1:
        parts.append(
            f'<a class="pagination__link" rel="prev" href="{root}{page_url(base, page - 1)}">{prev_text}</a>'
        )
    else:
        parts.append(f'<span class="pagination__link is-disabled">{prev_text}</span>')

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
            f'<a class="pagination__link" rel="next" href="{root}{page_url(base, page + 1)}">{next_text}</a>'
        )
    else:
        parts.append(f'<span class="pagination__link is-disabled">{next_text}</span>')

    return f'<nav class="pagination" aria-label="{nav_label}">{"".join(parts)}</nav>'


def paginate(items: list, per_page: int) -> tuple[list[list], int]:
    """把列表切成每页 per_page 条。per_page <= 0 表示不分页。"""
    if not per_page or per_page <= 0 or len(items) <= per_page:
        return [list(items)], 1
    chunks = [items[i : i + per_page] for i in range(0, len(items), per_page)]
    return chunks, len(chunks)


# ---------- 文章详情 ----------

def post_page(*, config: dict, post: dict, prev_post, next_post, related=None, root: str = "../", interact_slug: str = "", author: dict | None = None) -> str:
    lang = _lang(config)
    options = config.get("options") or {}
    show_toc = options.get("showToc", True) is not False and len(post["toc"]) > 2

    if show_toc:
        toc_items = "".join(
            f'<li><a class="toc__link" href="#{esc(heading["id"])}" data-depth="{heading["depth"]}">'
            f'{esc(heading["text"])}</a></li>'
            for heading in post["toc"]
        )
        toc_html = f"""<aside class="toc" data-toc>
  <div class="toc__title" data-i18n="post.toc">{T("post.toc", lang)}</div>
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
            f'<span class="post-nav__label" data-i18n="post.prev">← {T("post.prev", lang)}</span>'
            f'<span class="post-nav__title">{esc(prev_post["title"])}</span></a>'
        )
    if next_post:
        nav_parts.append(
            f'<a class="post-nav__item post-nav__item--next" href="{root}{next_post["url"]}">'
            f'<span class="post-nav__label" data-i18n="post.next">{T("post.next", lang)} →</span>'
            f'<span class="post-nav__title">{esc(next_post["title"])}</span></a>'
        )
    nav_html = f'<div class="post-nav">\n  {"".join(nav_parts)}\n</div>' if nav_parts else ""
    related_html = related_posts_block(posts=related, root=root) if related else ""

    if post.get("updated"):
        _updated_text = T("post.updated", lang, date=_short_date(post["updated"]))
        _updated_args = json.dumps({"date": _short_date(post["updated"])}, ensure_ascii=False)
        updated_html = (
            f'<span class="meta-dot"></span>'
            f'<span class="meta-text" data-i18n="post.updated" data-i18n-args="{esc(_updated_args)}">'
            f'{_updated_text}</span>'
        )
    else:
        updated_html = ""
    summary_html = f'<p class="article-head__summary">{esc(post["summary"])}</p>' if post.get("summary") else ""

    # V7：本文属于某个系列时给一条指回系列页的线索（静态文章与云端文章共用）。
    _series_name = str(post.get("series") or "").strip()
    if _series_name:
        series_html = (
            f'<p class="article-head__series" data-series>'
            f'<span class="article-head__series-label" data-i18n="series.of">{T("series.of", lang)}</span>'
            f'<a class="article-head__series-link" href="{root}series/{slugify(_series_name)}.html">'
            f'{esc(_series_name)}</a></p>'
        )
    else:
        series_html = ""

    # 署名：只对「有公开主页的云端作者」出现（静态文章的作者就是站长本人，
    # 全站页脚已经写了，重复署名反而啰嗦）
    if author and author.get("name"):
        author_name = esc(author["name"])
        if author.get("url"):
            author_html = (
                f'<a class="author-link" href="{root}{author["url"]}">{author_name}</a>'
                f'<span class="meta-dot"></span>'
            )
        else:
            author_html = f'<span class="meta-text">{author_name}</span><span class="meta-dot"></span>'
    else:
        author_html = ""

    # 日期同时写两版（data-i18n-config），切语言时无需刷新即可换格式；
    # 用 <time datetime> 让机器可读的部分保持 ISO 不变。
    iso_date = _short_date(post["date"])
    date_attr = i18n_config_attr(
        {"zh-CN": _full_date(post["date"], "zh-CN"), "en": _full_date(post["date"], "en")},
        _full_date(post["date"], lang),
    )
    date_html = (
        f'<time class="meta-text" datetime="{iso_date}"{date_attr}>'
        f'{esc(_full_date(post["date"], lang))}</time>'
    )

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("posts.title", lang), None, "posts.title")], root)}
    <header class="article-head">
      <span class="eyebrow">{esc(post["tags"][0] if post["tags"] else T("post.eyebrowDefault", lang))}</span>
      <h1 class="article-head__title">{esc(post["title"])}</h1>
      <div class="article-head__meta">
        {author_html}{date_html}
        <span class="meta-dot"></span>
        <span class="meta-text" data-i18n="post.reading" data-i18n-args="{post["reading_time"]}">
          {T("post.reading", lang, n=post["reading_time"])}</span>
        <span class="meta-dot"></span>
        <span class="meta-text" data-i18n="post.words" data-i18n-args="{post["words"]}">
          {T("post.words", lang, n=post["words"])}</span>
        {updated_html}
      </div>
      {series_html}
      {summary_html}
    </header>
  </div>
  <div class="article-layout">
    <article class="prose" data-article data-post-title="{esc(post["title"])}">{post["html"]}</article>
    {toc_html}
  </div>
  <footer class="article-foot">
    <div class="chip-row">{_tag_chips(post["tags"], root)}</div>
    {share_block(label=T("post.share", lang))}
    {nav_html}
    {related_html}
  </footer>
  {post_interact_block(post_slug=(interact_slug or post["slug"]), post_title=post["title"], root=root, login_next=post["url"], lang=lang)}
</div>"""


# ---------- 项目列表 ----------

def projects_page(*, config: dict, projects: list, root: str = "") -> str:
    lang = _lang(config)
    has_featured = any(project["featured"] for project in projects)
    featured_list = [p for p in projects if p["featured"]] if has_featured else []
    normal_list = [p for p in projects if not p["featured"]] if has_featured else projects

    if featured_list:
        featured_block = f"""<section class="section" style="margin-top:44px">
    <div class="section__head"><h2 class="section__title" data-i18n="projects.featured">{esc(T("projects.featured", lang))}</h2></div>
    <div class="project-grid">{"".join(_project_card(p, root) for p in featured_list)}</div>
  </section>"""
    else:
        featured_block = ""

    normal_head = (
        f'<div class="section__head"><h2 class="section__title" data-i18n="projects.all">{esc(T("projects.all", lang))}</h2></div>'
        if featured_list
        else ""
    )
    if normal_list:
        normal_body = f'<div class="project-grid">{"".join(_project_card(p, root) for p in normal_list)}</div>'
    else:
        normal_body = f'<div class="empty-state" data-i18n="projects.emptyHint">{esc(T("projects.emptyHint", lang))}</div>'
    normal_top = "56px" if featured_list else "44px"

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("projects.title", lang), None, "projects.title")], root=root)}
    <span class="eyebrow">Projects</span>
    <h1 class="article-head__title" style="margin-top:14px" data-i18n="home.projects">{esc(T("home.projects", lang))}</h1>
    <p class="article-head__summary" style="margin-top:18px" data-i18n="projects.lead" data-i18n-args="{len(projects)}">{esc(T("projects.lead", lang, n=len(projects)))}</p>
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
    lang = _lang(config)
    about = config.get("about") or {}
    initial = esc(str(config.get("author") or config.get("title") or "A").strip()[:1].upper())

    if about.get("skills"):
        skills = f"""<section class="section">
  <div class="section__head"><h2 class="section__title" data-i18n="about.skills">{esc(T("about.skills", lang))}</h2></div>
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
  <div class="section__head"><h2 class="section__title" data-i18n="about.timeline">{esc(T("about.timeline", lang))}</h2></div>
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
        f'<section class="section"><div class="section__head">'
        f'<h2 class="section__title" data-i18n="about.findMe">{esc(T("about.findMe", lang))}</h2></div>'
        f'<div class="hero__actions" style="margin-top:0">{social}</div></section>'
        if social
        else ""
    )

    page_html = (
        page["html"]
        if page
        else f'<p data-i18n="about.empty">{esc(T("about.empty", lang))}</p>'
    )

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("about.title", lang), None, "about.title")], root=root)}
  </div>
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
    lang = _lang(config)
    cloud = "".join(
        f'<a class="tag-card" href="{root}tags/{tag["slug"]}.html"><span>{esc(tag["name"])}</span>'
        f'<span class="tag-card__count">{tag["count"]}</span></a>'
        for tag in tags
    )
    body = cloud or f'<div class="empty-state" data-i18n="tags.empty">{esc(T("tags.empty", lang))}</div>'
    summary = T("tags.summaryCount", lang, n=len(tags), m=len(posts))

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("tags.title", lang), None, "tags.title")], root=root)}
    <span class="eyebrow">Tags</span>
    <h1 class="article-head__title" style="margin-top:14px" data-i18n="tags.title">{esc(T("tags.title", lang))}</h1>
    <p class="article-head__summary" style="margin-top:18px"
       data-i18n="tags.summaryCount" data-i18n-args='{{"n":{len(tags)},"m":{len(posts)}}}'>{esc(summary)}</p>
  </div>
  <section class="section">
    <div class="tag-cloud">{body}</div>
  </section>
</div>"""


def tag_page(*, config: dict, tag: dict, posts: list, root: str = "../../") -> str:
    lang = _lang(config)
    post_list = "\n    ".join(_post_item(post, root, config) for post in posts)
    summary = T("tag.summary", lang, n=len(posts))

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav(
        [_crumb_home(config), (T("tags.title", lang), "tags.html", "tags.title"), (str(tag["name"]), None)],
        root=root,
    )}
    <span class="eyebrow">Tag</span>
    <h1 class="article-head__title" style="margin-top:14px">{esc(tag["name"])}</h1>
    <p class="article-head__summary" style="margin-top:18px"
       data-i18n="tag.summary" data-i18n-args="{len(posts)}">{esc(summary)}</p>
  </div>
  <section class="section" style="margin-top:44px">
    <ul class="post-list">{post_list}</ul>
  </section>
</div>"""


# ---------- 作者公开主页 ----------

def author_page(*, config: dict, author: dict, posts: list, root: str = "../") -> str:
    """某位作者的公开主页（authors/<owner_id>.html）。

    构建期只为「有已发布文章的作者」生成这一页（见 build.py），
    所以页面上一定至少有 1 篇，不会出现空壳主页。
    数据来自 profiles_public 视图：只有 owner_id / nickname / avatar_url / bio，
    不含邮箱等 PII。
    """
    name = str(author.get("name") or author.get("nickname") or "").strip() or "匿名作者"
    avatar = str(author.get("avatar_url") or "").strip()
    bio = str(author.get("bio") or "").strip()
    initial = (name[:1] or "A").upper()

    if _is_http(avatar):
        avatar_html = (
            f'<img class="author-hero__avatar" src="{esc(avatar)}" alt="{esc(name)}" loading="lazy">'
        )
    else:
        avatar_html = (
            f'<span class="author-hero__avatar author-hero__avatar--text" aria-hidden="true">'
            f"{esc(initial)}</span>"
        )
    bio_html = f'<p class="author-hero__bio">{esc(bio)}</p>' if bio else ""
    post_list = "\n    ".join(_post_item(post, root, config) for post in posts)

    return f"""<div class="wrap">
  <div class="page-head">
    <nav class="breadcrumb" aria-label="面包屑">
      <a href="{root}index.html">首页</a>
      <span class="breadcrumb__sep">/</span>
      <span>作者</span>
    </nav>
    <header class="author-hero">
      {avatar_html}
      <div class="author-hero__main">
        <span class="eyebrow">Author</span>
        <h1 class="author-hero__name">{esc(name)}</h1>
        {bio_html}
        <p class="author-hero__stat">已发布 {len(posts)} 篇文章</p>
      </div>
    </header>
  </div>
  <section class="section" style="margin-top:44px">
    <div class="section__head"><h2 class="section__title">全部文章</h2></div>
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
    feed: list | None = None,
    page_size: int = 0,
) -> str:
    """归档页：按年分组的时间轴列表。支持分页（archive.html / archive-2.html …）。

    关于 V2（热门排序）与 V3（加载更多）：这两个交互都**需要跨页数据**，
    而静态站点翻页是「多份 HTML」，所以第 1 页会额外内联一份精简的全量
    清单（``<script type="application/json" data-archive-feed>``）。
    浏览器端 ``app.js`` 拿它做排序与增量显示；没有 JS 时这份数据没人读，
    访客看到的就是服务端渲染好的分页 —— 两边都能用，且首屏是服务端渲染的。
    """
    lang = _lang(config)
    years: dict[str, list] = {}
    for post in posts:
        local = post["date"].astimezone()
        years.setdefault(str(local.year), []).append(post)
    year_names = sorted(years, reverse=True)

    def _metrics_inline(post: dict) -> str:
        views = int(post.get("views") or 0)
        likes = int(post.get("likes") or 0)
        comments = int(post.get("comment_count") or 0)
        bits = []
        if views:
            bits.append(f'{views} <span data-i18n="list.metricViews">{esc(T("list.metricViews", lang))}</span>')
        if likes:
            bits.append(f'{likes} <span data-i18n="list.metricLikes">{esc(T("list.metricLikes", lang))}</span>')
        if comments:
            bits.append(f'{comments} <span data-i18n="list.metricComments">{esc(T("list.metricComments", lang))}</span>')
        return " · ".join(bits)

    year_blocks = []
    for year in year_names:
        items = "\n    ".join(
            f'<a class="archive-item" href="{root}{post["url"]}" data-hot="{int(post.get("hot") or 0)}">'
            f'<span class="archive-item__date">{_short_date(post["date"])}</span>'
            f'<span class="archive-item__title">{esc(post["title"])}</span>'
            f'<span class="archive-item__read">{post.get("reading_time", "")} '
            f'<span data-i18n="common.minutes">{esc(T("common.minutes", lang))}</span></span>'
            f'<span class="archive-item__metrics">{_metrics_inline(post)}</span></a>'
            for post in years[year]
        )
        year_blocks.append(
            f'<section class="archive-year">\n'
            f'  <h2 class="archive-year__title">{esc(year)} '
            f'<span data-i18n="archive.postsCount" data-i18n-args="{len(years[year])}">'
            f'{esc(T("archive.postsCount", lang, n=len(years[year])))}</span></h2>\n'
            f'  <div class="archive-list">\n    {items}\n  </div>\n'
            f"</section>"
        )
    body = "\n".join(year_blocks) or f'<div class="empty-state" data-i18n="archive.empty">{esc(T("archive.empty", lang))}</div>'
    total_count = total if total is not None else len(posts)

    page_note = (
        f'<span class="breadcrumb__sep">/</span><span>{esc(T("archive.page", lang, n=page))}</span>'
        if page > 1
        else ""
    )
    if total_pages > 1:
        summary = T("archive.summaryPaged", lang, total=total_count, page=page, pages=total_pages)
    else:
        summary = T("archive.summary", lang, total=total_count)

    # 第 1 页内联全量清单（供客户端排序 / 加载更多）。第 2 页起不再重复。
    # 调用方传进来的 feed 已经是完整字典 {pageSize,total,items}；
    # 这里做一次归一化，同时兼容「只传 items 列表」的用法，
    # 避免出现 items 里再套一层 {pageSize,total,items} 的双层结构。
    if isinstance(feed, dict):
        feed_items = list(feed.get("items") or [])
        feed_payload = feed
    else:
        feed_items = list(feed or [])
        feed_payload = {
            "pageSize": page_size or len(feed_items),
            "total": total_count,
            "items": feed_items,
        }

    feed_script = ""
    if feed_items and page == 1:
        feed_script = (
            '<script type="application/json" data-archive-feed>'
            + json.dumps(feed_payload, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

    toolbar = ""
    if feed_items and page == 1 and len(feed_items) > 1:
        toolbar = f"""<div class="toolbar toolbar--archive" data-archive-toolbar>
    <span class="toolbar__label" data-i18n="list.sort">{esc(T("list.sort", lang))}</span>
    <div class="seg" role="radiogroup" aria-label="{esc(T("list.sort", lang))}">
      <button class="seg__btn is-active" type="button" role="radio" aria-checked="true" data-sort="latest"
              data-i18n="list.sortLatest">{esc(T("list.sortLatest", lang))}</button>
      <button class="seg__btn" type="button" role="radio" aria-checked="false" data-sort="hot"
              data-i18n="list.sortHot" data-i18n-attr="title:list.sortHotTitle"
              title="{esc(T("list.sortHotTitle", lang))}">{esc(T("list.sortHot", lang))}</button>
    </div>
  </div>"""

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("archive.title", lang), None, "archive.title")], root=root, extra=page_note)}
    <span class="eyebrow">Archive</span>
    <h1 class="article-head__title" style="margin-top:14px" data-i18n="archive.title">{esc(T("archive.title", lang))}</h1>
    <p class="article-head__summary" style="margin-top:18px">{esc(summary)}</p>
  </div>
  {toolbar}
  <div class="archive" data-archive-list>{body}</div>
  <p class="list-note" data-load-more-note hidden data-i18n="list.loadedAll">{esc(T("list.loadedAll", lang))}</p>
  <div class="list-more">
    <button class="btn btn--ghost" type="button" data-load-more hidden data-i18n="list.loadMore">{esc(T("list.loadMore", lang))}</button>
  </div>
  {pagination(base="archive.html", page=page, total_pages=total_pages, root=root, lang=lang)}
  {feed_script}
</div>"""


def offline_page(*, config: dict, root: str = "") -> str:
    """离线兜底页：Service Worker 在断网且无缓存时展示。"""
    lang = _lang(config)
    return f"""<div class="wrap" style="padding:110px 0;text-align:center">
  <div class="mono" style="font-size:4.2rem;font-weight:700;line-height:1;background:linear-gradient(120deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent">OFFLINE</div>
  <h1 style="font-size:1.3rem;margin:20px 0 10px" data-i18n="offline.title">{esc(T("offline.title", lang))}</h1>
  <p style="color:var(--text-dim);font-size:.92rem;margin:0 auto 30px;max-width:460px" data-i18n="offline.lead">
    {esc(T("offline.lead", lang))}
  </p>
  <a class="btn btn--primary" href="{root}index.html" data-i18n="offline.retry">{esc(T("offline.retry", lang))}</a>
</div>"""


def not_found_page(
    *, config: dict | None = None, root: str = "", posts: list | None = None, tags: list | None = None
) -> str:
    """404：给访客留出路 —— 搜索、最新文章、热门标签。

    传统站点的 404 都会做「补救导航」，否则访客从搜索引擎落到一个死链后只能离开。
    """
    lang = _lang(config)
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
    <div class="section__head"><h2 class="section__title" data-i18n="notFound.latest">{esc(T("notFound.latest", lang))}</h2>
      <a class="section__more" href="{root}archive.html" data-i18n="common.all">{esc(T("common.all", lang))} →</a></div>
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
    <div class="section__head"><h2 class="section__title" data-i18n="notFound.hotTags">{esc(T("notFound.hotTags", lang))}</h2>
      <a class="section__more" href="{root}tags.html" data-i18n="tags.title">{esc(T("tags.title", lang))} →</a></div>
    <div class="chip-row">{tag_chips}</div>
  </section>"""
        if tag_chips
        else ""
    )

    return f"""<div class="wrap not-found">
  <div class="not-found__head">
    <div class="not-found__code mono">404</div>
    <h1 class="not-found__title" data-i18n="notFound.title">{esc(T("notFound.title", lang))}</h1>
    <p class="not-found__desc" data-i18n="notFound.lead">{esc(T("notFound.lead", lang))}</p>
    <div class="hero__actions">
      <button class="btn btn--primary" type="button" data-search-open data-i18n="notFound.search">{esc(T("notFound.search", lang))}</button>
      <a class="btn btn--ghost" href="{root}index.html" data-i18n="notFound.backHome">{esc(T("notFound.backHome", lang))}</a>
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


def post_interact_block(
    *,
    post_slug: str,
    post_title: str,
    root: str = "../",
    login_next: str = "",
    lang: str | None = None,
) -> str:
    """文章页的点赞 / 收藏 / 评论区。

    ``data-post-slug`` 写在容器上，interact.js 启动时直接读取并初始化。
    """
    lang = normalize_lang(lang)
    target = login_next or post_slug
    login_href = f'{root}login.html?next={quote("/" + target, safe="/")}'

    return f"""<section class="interact" data-interact data-post-slug="{esc(post_slug)}" data-post-title="{esc(post_title)}">
  <div class="interact__bar">
    <button class="interact__btn" type="button" data-like aria-pressed="false">
      {_LOGIN_ICONS["heart"]}<span data-i18n="interact.like">{esc(T("interact.like", lang))}</span><span class="interact__count" data-like-count>0</span>
    </button>
    <button class="interact__btn" type="button" data-bookmark aria-pressed="false">
      {_LOGIN_ICONS["bookmark"]}<span data-bookmark-label data-i18n="interact.bookmark">{esc(T("interact.bookmark", lang))}</span>
    </button>
    <span class="interact__views">
      {_LOGIN_ICONS["eye"]}<span data-views-count>0</span> <span data-i18n="interact.views">{esc(T("interact.views", lang))}</span>
    </span>
  </div>
  <div class="comments">
    <div class="comments__head">
      <h2 class="comments__title">{_LOGIN_ICONS["comment"]}<span data-i18n="interact.comments">{esc(T("interact.comments", lang))}</span></h2>
      <span class="comments__count"><span data-comment-count>0</span> <span data-i18n="interact.count">{esc(T("interact.count", lang))}</span></span>
    </div>
    <div class="comment-gate" data-comment-gate>
      <p data-i18n="interact.gate">{esc(T("interact.gate", lang))}</p>
      <a class="btn btn--primary btn--sm" href="{login_href}" data-i18n="auth.login">{esc(T("auth.login", lang))}</a>
    </div>
    <form class="comment-form" data-comment-form hidden>
      <div class="comment-form__target" data-reply-bar hidden>
        <span data-i18n="interact.replying">{esc(T("interact.replying", lang))}</span> <strong data-reply-name></strong>
        <button class="comment-form__cancel" type="button" data-reply-cancel data-i18n="interact.cancel">{esc(T("interact.cancel", lang))}</button>
      </div>
      <textarea class="comment-form__input" data-comment-input rows="3" maxlength="1000" placeholder="{esc(T("interact.placeholder", lang))}" data-i18n-attr="placeholder:interact.placeholder"></textarea>
      <div class="comment-format" data-comment-format>
        <button class="comment-format__btn" type="button" data-emoji-toggle aria-expanded="false">
          <span aria-hidden="true">😊</span> <span data-i18n="interact.emoji">{esc(T("interact.emoji", lang))}</span>
        </button>
        <button class="comment-format__btn" type="button" data-code-insert>
          <span aria-hidden="true">&#96;&#96;&#96;</span> <span data-i18n="interact.insertCode">{esc(T("interact.insertCode", lang))}</span>
        </button>
        <span class="comment-format__hint" data-i18n="interact.formatHint">{esc(T("interact.formatHint", lang))}</span>
        <div class="emoji-picker" data-emoji-picker hidden></div>
      </div>
      <div class="comment-form__foot">
        <span class="comment-form__hint">
          <span data-i18n="interact.hint">{esc(T("interact.hint", lang))}</span>
          <span class="comment-form__sep">·</span>
          <span data-i18n="interact.mentionHint">{esc(T("interact.mentionHint", lang))}</span>
        </span>
        <button class="btn btn--primary btn--sm" type="submit" data-comment-submit data-i18n="interact.submit">{esc(T("interact.submit", lang))}</button>
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
    lang = _lang(config)

    def L(key: str) -> str:
        return esc(T(key, lang))

    def A(attr: str, key: str) -> str:
        """把属性也接进 i18n（如 placeholder）：切语言时由 i18n.js 一并替换。"""
        return f'{attr}="{L(key)}" data-i18n-attr="{attr}:{key}"'

    return f"""<div class="wrap auth-page">
  <div class="auth-card">
    <aside class="auth-card__aside">
      <span class="eyebrow">Account</span>
      <h2 class="auth-aside__title" data-i18n="auth.asideTitle">{L("auth.asideTitle")}</h2>
      <p class="auth-aside__text" data-i18n="auth.asideText">
        {L("auth.asideText")}
      </p>
      <ul class="auth-aside__list">
        <li>{_LOGIN_ICONS["user"]}<div><strong data-i18n="auth.roleUser">{L("auth.roleUser")}</strong><span data-i18n="auth.roleUserDesc">{L("auth.roleUserDesc")}</span></div></li>
        <li>{_LOGIN_ICONS["shield"]}<div><strong data-i18n="auth.roleAdmin">{L("auth.roleAdmin")}</strong><span data-i18n="auth.roleAdminDesc">{L("auth.roleAdminDesc")}</span></div></li>
      </ul>
      <p class="auth-aside__foot" data-i18n="auth.asideFoot">{L("auth.asideFoot")}</p>
    </aside>

    <div class="auth-card__main">
      <div data-auth-form-wrap>
        <h1 class="auth-card__title" data-auth-title data-i18n="auth.title">{L("auth.title")}</h1>
        <p class="auth-card__lead" data-auth-lead data-i18n="auth.cardLead">{L("auth.cardLead")}</p>

        <form class="auth-form" data-auth-form novalidate>
          <label class="field">
            <span class="field__label" data-i18n="auth.email">{L("auth.email")}</span>
            <input class="field__input" type="email" name="email" {A("placeholder", "auth.emailPlaceholder")}
                   autocomplete="email" spellcheck="false" required>
          </label>

          <div class="auth-tabs" role="tablist" aria-label="{L("auth.method")}" data-i18n-attr="aria-label:auth.method">
            <button class="auth-tab is-active" type="button" role="tab" aria-selected="true" data-tab="password" data-i18n="auth.tabPassword">{L("auth.tabPassword")}</button>
            <button class="auth-tab" type="button" role="tab" aria-selected="false" data-tab="otp" data-i18n="auth.tabCode">{L("auth.tabCode")}</button>
          </div>

          <div class="auth-panel" data-panel="password">
            <label class="field">
              <span class="field__label" data-i18n="auth.password">{L("auth.password")}</span>
              <input class="field__input" type="password" name="password" {A("placeholder", "auth.passwordPlaceholder")}
                     autocomplete="current-password">
            </label>
          </div>

          <div class="auth-panel" data-panel="otp" hidden>
            <label class="field">
              <span class="field__label" data-i18n="auth.code">{L("auth.code")}</span>
              <div class="field__row">
                <input class="field__input" type="text" name="code" inputmode="numeric" {A("placeholder", "auth.codePlaceholder")}
                       autocomplete="one-time-code">
                <button class="btn btn--ghost btn--sm" type="button" data-send-code data-i18n="auth.getCode">{L("auth.getCode")}</button>
              </div>
            </label>
            <label class="field">
              <span class="field__label" data-i18n="auth.signupPasswordLabel">{L("auth.signupPasswordLabel")}</span>
              <input class="field__input" type="password" name="signupPassword" {A("placeholder", "auth.newPasswordPlaceholder")}
                     autocomplete="new-password">
            </label>
          </div>

          <div class="auth-error" data-auth-error hidden></div>
          <div class="auth-lock" data-auth-lock hidden></div>
          <div class="auth-notice" data-auth-notice hidden></div>

          <button class="btn btn--primary btn--block" type="submit" data-auth-submit data-i18n="auth.submitPassword">{L("auth.submitPassword")}</button>

          <div class="auth-oauth" data-oauth hidden>
            <div class="auth-oauth__sep"><span data-i18n="auth.oauthOr">{L("auth.oauthOr")}</span></div>
            <div class="auth-oauth__buttons" data-oauth-buttons></div>
          </div>
        </form>

        <p class="auth-foot">
          <span data-i18n="auth.privacy">{L("auth.privacy")}</span>
          <button class="link-btn" type="button" data-auth-forgot data-i18n="auth.forgot">{L("auth.forgot")}</button>
        </p>
      </div>

      <div data-reset-wrap hidden>
        <h1 class="auth-card__title" data-i18n="auth.resetTitle">{L("auth.resetTitle")}</h1>
        <p class="auth-card__lead" data-i18n="auth.resetLead">{L("auth.resetLead")}</p>

        <form class="auth-form" data-reset-form novalidate>
          <label class="field">
            <span class="field__label" data-i18n="auth.email">{L("auth.email")}</span>
            <input class="field__input" type="email" name="resetEmail" {A("placeholder", "auth.emailPlaceholder")}
                   autocomplete="email" spellcheck="false" required>
          </label>

          <label class="field">
            <span class="field__label" data-i18n="auth.code">{L("auth.code")}</span>
            <div class="field__row">
              <input class="field__input" type="text" name="resetCode" inputmode="numeric"
                     {A("placeholder", "auth.resetCodePlaceholder")} autocomplete="one-time-code">
              <button class="btn btn--ghost btn--sm" type="button" data-reset-send data-i18n="auth.getCode">{L("auth.getCode")}</button>
            </div>
          </label>

          <label class="field">
            <span class="field__label" data-i18n="auth.resetNewLabel">{L("auth.resetNewLabel")}</span>
            <input class="field__input" type="password" name="resetPassword" {A("placeholder", "auth.resetNew")}
                   autocomplete="new-password">
          </label>

          <label class="field">
            <span class="field__label" data-i18n="auth.resetConfirmLabel">{L("auth.resetConfirmLabel")}</span>
            <input class="field__input" type="password" name="resetPassword2" {A("placeholder", "auth.resetRepeat")}
                   autocomplete="new-password">
          </label>

          <div class="auth-error" data-reset-error hidden></div>
          <div class="auth-notice" data-reset-notice hidden></div>

          <button class="btn btn--primary btn--block" type="submit" data-reset-submit data-i18n="auth.resetSubmitFull">{L("auth.resetSubmitFull")}</button>
        </form>

        <p class="auth-foot">
          <button class="link-btn" type="button" data-reset-back data-i18n="auth.backToLogin">← {L("auth.backToLogin")}</button>
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
    lang = _lang(config)

    def L(key: str) -> str:
        return esc(T(key, lang))

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
          <div><dt>邮箱</dt><dd><span data-account-email>—</span> <span class="badge badge--muted" data-email-status hidden>—</span></dd></div>
          <div><dt>身份</dt><dd data-account-role>—</dd></div>
          <div><dt>注册时间</dt><dd data-account-joined>—</dd></div>
        </dl>
        <p class="account-card__pending" data-account-pending hidden></p>
        <div class="account-card__actions">
          <button class="btn btn--ghost btn--sm" type="button" data-account-identity hidden>切换身份</button>
          <button class="btn btn--danger btn--sm" type="button" data-account-signout>退出登录</button>
        </div>
      </div>
    </aside>

    <div class="account-main">
      <section class="panel" data-onboard-target>
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
            <span class="field__note">上传后可以在弹窗里裁剪并压缩，不会把手机原图直接塞进存储。</span>
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
          <h2 class="panel__title">账号安全</h2>
          <span class="panel__hint">改完立即生效，当前登录不会被踢下线</span>
        </div>
        <form class="form-grid" onsubmit="return false">
          <label class="field field--full">
            <span class="field__label">当前密码</span>
            <input class="field__input" type="password" autocomplete="current-password" maxlength="64"
                   placeholder="用来确认是你本人操作" data-password-old>
          </label>
          <label class="field">
            <span class="field__label">新密码</span>
            <input class="field__input" type="password" autocomplete="new-password" maxlength="64"
                   placeholder="至少 8 位" data-password-new>
          </label>
          <label class="field">
            <span class="field__label">确认新密码</span>
            <input class="field__input" type="password" autocomplete="new-password" maxlength="64"
                   placeholder="再输一次" data-password-confirm>
          </label>
          <div class="form-grid__foot">
            <button class="btn btn--primary btn--sm" type="button" data-password-save>修改密码</button>
            <span class="field__note">忘记当前密码？到 <a href="{root}login.html">登录页</a> 点「忘记密码」走邮箱重置。</span>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">邮箱</h2>
          <span class="panel__hint" data-i18n="account.emailVerifyHint">{L("account.emailVerifyHint")}</span>
        </div>

        <div class="inline-form">
          <input class="field__input mono" type="email" readonly data-email-readonly>
          <span class="badge badge--muted" data-email-badge hidden>—</span>
          <button class="btn btn--ghost btn--sm" type="button" data-email-verify>{L("account.emailVerify")}</button>
        </div>

        <div class="verify-box" data-email-verify-box hidden>
          <div class="inline-form">
            <input class="field__input" type="text" inputmode="numeric" placeholder="{L("auth.codePlaceholder")}"
                   data-email-code>
            <button class="btn btn--ghost btn--sm" type="button" data-email-code-send>{L("account.emailVerifySend")}</button>
            <button class="btn btn--primary btn--sm" type="button" data-email-code-submit>{L("account.emailVerifySubmit")}</button>
          </div>
          <span class="field__note" data-email-verify-note></span>
        </div>

        <details class="account-details">
          <summary>{L("account.emailChange")}</summary>
          <p class="field__note" data-i18n="account.emailChangeHint">{L("account.emailChangeHint")}</p>
          <form class="form-grid" onsubmit="return false">
            <label class="field">
              <span class="field__label">{L("account.emailNew")}</span>
              <input class="field__input" type="email" placeholder="new@example.com" data-email-new>
            </label>
            <label class="field">
              <span class="field__label">{L("account.emailPassword")}</span>
              <input class="field__input" type="password" autocomplete="current-password" maxlength="64"
                     data-email-password>
            </label>
            <label class="field field--full">
              <span class="field__label">{L("account.emailNote")}</span>
              <input class="field__input" type="text" maxlength="200" data-email-change-note>
            </label>
            <div class="form-grid__foot">
              <button class="btn btn--primary btn--sm" type="button" data-email-change-submit>{L("account.emailSubmit")}</button>
            </div>
          </form>
        </details>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">{L("account.sessions")}</h2>
          <span class="panel__hint" data-i18n="account.sessionsHint">{L("account.sessionsHint")}</span>
        </div>
        <ul class="stack" data-session-list>
          <li class="stack-empty">加载中…</li>
        </ul>
        <div class="form-grid__foot">
          <button class="btn btn--danger btn--sm" type="button" data-session-kill>{L("account.sessionKill")}</button>
        </div>
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
          <span class="panel__hint" data-i18n="account.bookmarkPrivateHint">{L("account.bookmarkPrivateHint")}</span>
        </div>
        <div class="chip-row" data-folder-bar></div>
        <ul class="stack" data-my-bookmarks>
          <li class="stack-empty">加载中…</li>
        </ul>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">{L("reading.title")}</h2>
        </div>
        <ul class="stack" data-my-reading>
          <li class="stack-empty">加载中…</li>
        </ul>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">{L("account.blocks")}</h2>
          <span class="panel__hint" data-i18n="account.blocksHint">{L("account.blocksHint")}</span>
        </div>
        <ul class="stack" data-my-blocks>
          <li class="stack-empty">加载中…</li>
        </ul>
      </section>

      <section class="panel panel--danger">
        <div class="panel__head">
          <h2 class="panel__title">{L("account.dataTitle")}</h2>
        </div>
        <div class="data-actions">
          <div class="data-action">
            <strong>{L("account.export")}</strong>
            <p class="field__note" data-i18n="account.exportHint">{L("account.exportHint")}</p>
            <button class="btn btn--ghost btn--sm" type="button" data-export-data>{L("account.export")}</button>
          </div>
          <div class="data-action">
            <strong>{L("account.delete")}</strong>
            <p class="field__note" data-i18n="account.deleteHint">{L("account.deleteHint")}</p>
            <button class="btn btn--danger btn--sm" type="button" data-delete-account>{L("account.delete")}</button>
          </div>
        </div>
      </section>
    </div>
  </div>

  <div class="modal" data-avatar-modal hidden>
    <div class="modal__panel modal__panel--crop">
      <h3 class="modal__title">{L("account.cropTitle")}</h3>
      <p class="field__note" data-i18n="account.cropHint">{L("account.cropHint")}</p>
      <div class="crop-stage" data-crop-stage>
        <canvas class="crop-canvas" data-crop-canvas width="256" height="256"></canvas>
      </div>
      <label class="field">
        <span class="field__label">{L("account.cropZoom")}</span>
        <input class="field__input" type="range" min="100" max="320" value="100" data-crop-zoom>
      </label>
      <div class="modal__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-crop-cancel>{L("account.cropCancel")}</button>
        <button class="btn btn--primary btn--sm" type="button" data-crop-apply>{L("account.cropApply")}</button>
      </div>
    </div>
  </div>

  <div class="modal" data-delete-modal hidden>
    <div class="modal__panel">
      <h3 class="modal__title">{L("account.deleteTitle")}</h3>
      <p class="field__note" data-i18n="account.deleteHint">{L("account.deleteHint")}</p>
      <label class="field">
        <span class="field__label">{L("account.deleteType")}</span>
        <input class="field__input mono" type="text" autocomplete="off" spellcheck="false" placeholder="DELETE"
               data-delete-confirm>
      </label>
      <div class="modal__actions">
        <button class="btn btn--ghost btn--sm" type="button" data-delete-cancel>{L("account.deleteCancel")}</button>
        <button class="btn btn--danger btn--sm" type="button" data-delete-submit>{L("account.deleteSubmit")}</button>
      </div>
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
        <label class="field">
          <span class="field__label">期望发布时间（可留空）</span>
          <input class="field__input" type="datetime-local" data-write-schedule>
          <span class="field__hint">留空 = 交由站长在审核时决定；填未来时间 = 审核通过后到点自动上线，不填就是通过即上线。</span>
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
          <li>已发布的文章<strong>可以自己改</strong>：受信任作者改完立即生效；其他人改完进入待审，
            审核期间线上仍是原文，不会出现「改稿即下架」的断档。</li>
          <li>填了「期望发布时间」而那个时间还没到，文章会先<strong>挂着</strong>，到点自动上线。</li>
          <li>请勿提交违规、侵权或与本站主题无关的内容。</li>
        </ul>
      </div>

      <div class="panel" data-preview-panel>
        <div class="panel__head">
          <h2 class="panel__title">预览链接</h2>
          <span class="panel__hint">给别人看还没发布的稿子</span>
        </div>
        <p class="side-note" data-preview-hint>
          先保存草稿，再生成一条随机链接。对方无需注册就能看到这一版内容；
          链接只能读，不能改，也可以随时撤销。
        </p>
        <div class="inline-form inline-form--tight">
          <select class="field__input field__input--select" data-preview-days>
            <option value="1">1 天</option>
            <option value="7" selected>7 天</option>
            <option value="30">30 天</option>
            <option value="90">90 天</option>
          </select>
          <button class="btn btn--primary btn--sm" type="button" data-preview-create>生成链接</button>
        </div>
        <ul class="stack stack--links" data-preview-list>
          <li class="stack-empty">保存草稿后可用</li>
        </ul>
      </div>

      <div class="panel" data-revisions-panel>
        <div class="panel__head">
          <h2 class="panel__title">修订历史</h2>
          <span class="panel__hint">保留最近 30 版</span>
        </div>
        <p class="side-note">
          每次内容有改动就自动存一版。改坏了可以回滚 ——
          受信任作者立即生效，其他人会转成待审，线上不受影响。
        </p>
        <ul class="stack stack--links" data-revision-list>
          <li class="stack-empty">保存草稿后可用</li>
        </ul>
        <div class="revision-view" data-revision-view hidden>
          <div class="revision-view__head">
            <span data-revision-title></span>
            <button class="btn btn--ghost btn--sm" type="button" data-revision-close>收起</button>
          </div>
          <pre class="revision-view__body" data-revision-body></pre>
          <div class="revision-view__foot">
            <button class="btn btn--ghost btn--sm" type="button" data-revision-restore>回滚到这一版</button>
          </div>
        </div>
      </div>
    </aside>
  </div>
</div>"""


# ---------- 管理员后台 ----------

def admin_page(*, config: dict, root: str = "") -> str:
    return f"""<div class="wrap" data-admin>
  <div class="page-head admin-head">
    <div class="admin-head__text">
      <span class="eyebrow">Admin</span>
      <h1 class="article-head__title" style="margin-top:14px">管理后台</h1>
      <p class="article-head__summary" style="margin-top:18px">
        在线撰写与发布文章、管理评论与用户。这里的每一项操作都会经过服务端权限校验，非管理员无法调用。
      </p>
    </div>
    <div class="admin-head__actions">
      <button class="btn btn--ghost btn--sm" type="button" data-admin-refresh>刷新数据</button>
      <a class="btn btn--ghost btn--sm" href="{root}index.html">返回站点</a>
    </div>
  </div>

  <section class="admin-triage" aria-label="待你处理">
    <div class="admin-triage__head">
      <h2 class="admin-section__title">待你处理</h2>
      <span class="admin-section__hint">点卡片直接跳到对应分区</span>
    </div>
    <div class="triage-grid">
      <button class="triage-card" type="button" data-admin-goto="review" data-triage="submission">
        <span class="triage-card__top">
          <span class="triage-card__label">待审核投稿</span>
          <span class="triage-card__go" aria-hidden="true">去处理 →</span>
        </span>
        <span class="triage-card__value" data-triage-value data-stat-pending>0</span>
        <span class="triage-card__hint">读者投的稿，通过后前台才可见</span>
      </button>
      <button class="triage-card" type="button" data-admin-goto="review" data-triage="edit">
        <span class="triage-card__top">
          <span class="triage-card__label">待审改稿</span>
          <span class="triage-card__go" aria-hidden="true">去处理 →</span>
        </span>
        <span class="triage-card__value" data-triage-value data-stat-edit-pending>0</span>
        <span class="triage-card__hint">已发布文章的修改，线上暂时还是旧版</span>
      </button>
      <button class="triage-card" type="button" data-admin-goto="reports" data-triage="report">
        <span class="triage-card__top">
          <span class="triage-card__label">待处理举报</span>
          <span class="triage-card__go" aria-hidden="true">去处理 →</span>
        </span>
        <span class="triage-card__value" data-triage-value data-stat-open-reports>0</span>
        <span class="triage-card__hint">读者举报的评论，处理后会通知举报人</span>
      </button>
      <button class="triage-card" type="button" data-admin-goto="reports" data-triage="email">
        <span class="triage-card__top">
          <span class="triage-card__label">邮箱变更申请</span>
          <span class="triage-card__go" aria-hidden="true">去处理 →</span>
        </span>
        <span class="triage-card__value" data-triage-value data-stat-email-requests>0</span>
        <span class="triage-card__hint">需去云控制台改邮箱后再回来确认</span>
      </button>
    </div>
  </section>

  <details class="admin-metrics" data-admin-metrics>
    <summary class="admin-metrics__summary">
      <span class="admin-metrics__title">站点概况</span>
      <span class="admin-metrics__hint">注册量、阅读量、评论与文章存量等只读指标</span>
    </summary>
    <div class="admin-stats">
      <div class="admin-stat"><div class="admin-stat__value" data-stat-users>0</div><div class="admin-stat__label">注册用户</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-disabled>0</div><div class="admin-stat__label">已禁用账号</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-comments>0</div><div class="admin-stat__label">评论总数</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-today>0</div><div class="admin-stat__label">24h 新评论</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-views>0</div><div class="admin-stat__label">总阅读量</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-hidden>0</div><div class="admin-stat__label">已隐藏评论</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-pending-comments>0</div><div class="admin-stat__label">待审评论</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-likes>0</div><div class="admin-stat__label">点赞总数</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-posts>0</div><div class="admin-stat__label">在线文章</div></div>
      <div class="admin-stat"><div class="admin-stat__value" data-stat-drafts>0</div><div class="admin-stat__label">草稿</div></div>
    </div>
  </details>

  <nav class="admin-tabs" role="tablist" aria-label="后台分区">
    <span class="admin-tabs__label" role="presentation">内容</span>
    <button class="admin-tab is-active" type="button" role="tab" aria-selected="true" data-admin-tab="posts">文章管理</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="review">内容审核 <span class="admin-tab__badge" data-review-badge hidden>0</span></button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="comments">评论管理</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="spam">垃圾评论 <span class="admin-tab__badge" data-spam-badge hidden>0</span></button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="reports">举报与申请 <span class="admin-tab__badge" data-reports-badge hidden>0</span></button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="media">媒体库</button>
    <span class="admin-tabs__sep" aria-hidden="true"></span>
    <span class="admin-tabs__label" role="presentation">系统</span>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="stats">统计与访问</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="settings">站点设置</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="notify">通知与邮件 <span class="admin-tab__badge" data-outbox-badge hidden>0</span></button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="data">数据与备份</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="users">用户</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="admins">管理员</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="audit">操作日志</button>
    <button class="admin-tab" type="button" role="tab" aria-selected="false" data-admin-tab="system">安全与健康</button>
  </nav>

  <div class="admin-bulkbar" data-bulkbar hidden>
    <span class="admin-bulkbar__count">已选 <strong data-bulk-count>0</strong> 项</span>
    <span class="admin-bulkbar__scope" data-bulk-scope></span>
    <div class="admin-bulkbar__actions" data-bulk-actions></div>
    <button class="btn btn--ghost btn--xs" type="button" data-bulk-clear>取消选择</button>
  </div>

  <section class="admin-panel" data-admin-panel="audit" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">管理操作日志</h2>
        <span class="panel__hint">
          删帖、删评论、审核、用户封禁、配置变更等敏感操作的服务端留痕（共 <span data-audit-total>0</span> 条）
        </span>
      </div>
      <div class="admin-toolbar admin-toolbar--wrap">
        <input class="field__input" type="search" placeholder="搜索操作者 / 动作 / 备注 / 对象 ID" data-audit-search>
        <select class="field__input field__input--select" data-audit-action>
          <option value="">全部动作</option>
        </select>
        <input class="field__input" type="text" placeholder="操作者（邮箱或 ID）" data-audit-actor>
        <label class="field__inline">
          <span>从</span>
          <input class="field__input" type="date" data-audit-from>
        </label>
        <label class="field__inline">
          <span>到</span>
          <input class="field__input" type="date" data-audit-to>
        </label>
        <button class="btn btn--ghost btn--sm" type="button" data-audit-reset>重置</button>
        <button class="btn btn--ghost btn--sm" type="button" data-audit-export>导出当前筛选（CSV）</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
          <tbody data-audit-log>
            <tr><td colspan="5" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-audit-pager></div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="posts">
    <div class="admin-editor" data-editor-shell hidden>
      <div class="panel panel--editor">
        <div class="panel__head">
          <h2 class="panel__title" data-editor-title>写一篇新文章</h2>
          <div class="panel__head-actions">
            <span class="panel__hint">Markdown 语法，支持代码块与提示块</span>
            <button class="btn btn--ghost btn--sm" type="button" data-editor-close>收起编辑器</button>
          </div>
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
              <option value="scheduled">定时发布</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">发布时间（定时需填）</span>
            <input class="field__input" type="datetime-local" data-admin-schedule>
            <span class="field__hint">状态选「定时发布」时必填且要在未来；到点前前台不可见。</span>
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

        <div class="admin-editor__panels">
          <div class="panel" data-preview-panel>
            <div class="panel__head">
              <h2 class="panel__title">预览链接</h2>
              <span class="panel__hint">给别人看还没发布的稿子</span>
            </div>
            <p class="side-note" data-preview-hint>
              先保存草稿，再生成一条随机链接。对方无需注册就能看到这一版内容；
              链接只能读，不能改，也可以随时撤销。
            </p>
            <div class="inline-form inline-form--tight">
              <select class="field__input field__input--select" data-preview-days>
                <option value="1">1 天</option>
                <option value="7" selected>7 天</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
              </select>
              <button class="btn btn--primary btn--sm" type="button" data-preview-create>生成链接</button>
            </div>
            <ul class="stack stack--links" data-preview-list>
              <li class="stack-empty">保存草稿后可用</li>
            </ul>
          </div>

          <div class="panel" data-revisions-panel>
            <div class="panel__head">
              <h2 class="panel__title">修订历史</h2>
              <span class="panel__hint">保留最近 30 版</span>
            </div>
            <p class="side-note">
              每次内容有改动就自动存一版，改坏了可以一键回滚。管理员回滚立即生效。
            </p>
            <ul class="stack stack--links" data-revision-list>
              <li class="stack-empty">保存草稿后可用</li>
            </ul>
            <div class="revision-view" data-revision-view hidden>
              <div class="revision-view__head">
                <span data-revision-title></span>
                <button class="btn btn--ghost btn--sm" type="button" data-revision-close>收起</button>
              </div>
              <pre class="revision-view__body" data-revision-body></pre>
              <div class="revision-view__foot">
                <button class="btn btn--ghost btn--sm" type="button" data-revision-restore>回滚到这一版</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel admin-list">
      <div class="panel__head">
        <h2 class="panel__title">全部在线文章</h2>
        <div class="panel__head-actions">
          <span class="panel__hint">含管理员发布与用户投稿，共 <span data-post-count>0</span> 篇</span>
          <button class="btn btn--primary btn--sm" type="button" data-editor-open>写新文章</button>
        </div>
      </div>
        <div class="admin-toolbar">
          <input class="field__input" type="search" placeholder="搜索标题 / slug / 作者 / 邮箱" data-post-search>
          <select class="field__input field__input--select" data-post-status>
            <option value="all">全部状态</option>
            <option value="pending">待审核</option>
            <option value="published">已发布</option>
            <option value="scheduled">定时未到</option>
            <option value="edit_pending">待审改稿</option>
            <option value="draft">草稿</option>
            <option value="rejected">未通过</option>
            <option value="reviewed">已审过</option>
          </select>
          <label class="admin-check">
            <input type="checkbox" data-post-select-all>
            <span>全选本页</span>
          </label>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table admin-table--cards">
            <thead>
              <tr>
                <th class="admin-table__pick"></th>
                <th>标题</th><th>作者</th><th>状态</th><th>排序 / 定时</th><th>更新时间</th><th>操作</th>
              </tr>
            </thead>
            <tbody data-admin-posts>
              <tr><td colspan="7" class="admin-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>
      <div class="admin-pager" data-post-pager></div>
    </div>
  </section>

  <section class="admin-panel" data-admin-panel="review" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">内容审核</h2>
        <span class="panel__hint">三个队列分开看，不用一路往下滚</span>
      </div>
      <div class="admin-subtabs" role="tablist" aria-label="审核队列">
        <button class="admin-subtab is-active" type="button" role="tab" aria-selected="true" data-review-tab="pending">
          待审投稿 <span class="admin-subtab__count" data-review-count>0</span>
        </button>
        <button class="admin-subtab" type="button" role="tab" aria-selected="false" data-review-tab="edits">
          待审改稿 <span class="admin-subtab__count" data-edit-count>0</span>
        </button>
        <button class="admin-subtab" type="button" role="tab" aria-selected="false" data-review-tab="done">
          已处理
        </button>
      </div>

      <div class="admin-review-section" data-review-section="pending">
        <p class="admin-review__note">普通用户提交的稿件。通过后才会出现在前台。</p>
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

      <div class="admin-review-section" data-review-section="edits" hidden>
        <p class="admin-review__note">
          作者对<strong>已发布文章</strong>的修改。线上仍是旧版本 —— 读者在审核期间看到的是原文，通过后才替换。
        </p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>新标题 / 原标题</th><th>作者</th><th>提交时间</th><th>操作</th></tr></thead>
            <tbody data-admin-edits>
              <tr><td colspan="4" class="admin-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="admin-pager" data-edit-pager></div>
      </div>

      <div class="admin-review-section" data-review-section="done" hidden>
        <p class="admin-review__note">最近审核过的稿件，可随时下架或重新通过。</p>
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
          <button class="chip" type="button" data-comment-filter="pending">待审</button>
          <button class="chip" type="button" data-comment-filter="visible">显示中</button>
          <button class="chip" type="button" data-comment-filter="hidden">已隐藏</button>
          <button class="chip" type="button" data-comment-filter="spam">疑似垃圾</button>
        </div>
        <label class="admin-check">
          <input type="checkbox" data-comment-select-all>
          <span>全选本页</span>
        </label>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table admin-table--cards">
          <thead>
            <tr>
              <th class="admin-table__pick"></th>
              <th>作者 / 文章</th><th>内容</th><th>风险</th><th>时间</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody data-admin-comments>
            <tr><td colspan="7" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-comment-pager></div>
    </div>

    <details class="admin-fold">
      <summary class="admin-fold__summary">
        <span class="admin-fold__title">敏感词</span>
        <span class="admin-fold__hint">命中只给评论打标记、不自动隐藏（所有新评论本来就要过审，这里只是帮你先看一眼）</span>
      </summary>
      <div class="admin-fold__body">
        <div class="admin-toolbar">
          <input class="field__input" type="text" maxlength="40" placeholder="输入要拦截的词，如 加微信"
                 data-word-input>
          <button class="btn btn--primary btn--sm" type="button" data-word-add>添加</button>
        </div>
        <div class="chip-row" data-word-list>
          <span class="admin-empty">加载中…</span>
        </div>
      </div>
    </details>
  </section>

  <section class="admin-panel" data-admin-panel="reports" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">评论举报</h2>
        <span class="panel__hint">
          读者提交的举报。处理时会自动通知举报人；被举报评论可以直接隐藏或删除
          （当前 <span data-report-open>0</span> 条待处理）
        </span>
      </div>
      <div class="admin-toolbar">
        <div class="chip-row">
          <button class="chip is-active" type="button" data-report-filter="open">待处理</button>
          <button class="chip" type="button" data-report-filter="all">全部</button>
          <button class="chip" type="button" data-report-filter="resolved">已处理</button>
          <button class="chip" type="button" data-report-filter="dismissed">已忽略</button>
        </div>
        <label class="admin-check">
          <input type="checkbox" data-report-select-all>
          <span>全选本页</span>
        </label>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table admin-table--cards">
          <thead>
            <tr>
              <th class="admin-table__pick"></th>
              <th>举报人</th><th>被举报评论</th><th>原因</th><th>时间</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody data-admin-reports>
            <tr><td colspan="7" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-report-pager></div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">邮箱变更申请</h2>
        <span class="panel__hint">
          云平台没有开放改邮箱能力，所以只能走这条路：你在云控制台把用户的登录邮箱改掉，
          再回来点「已完成」，申请人会收到通知（当前 <span data-email-request-count>0</span> 条待处理）
        </span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>用户</th><th>当前邮箱</th><th>申请改为</th><th>说明</th><th>申请时间</th><th>操作</th></tr></thead>
          <tbody data-admin-email-requests>
            <tr><td colspan="6" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
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
          <option value="deleted">已注销</option>
          <option value="email">有待处理邮箱申请</option>
          <option value="admin">管理员</option>
          <option value="editor">编辑</option>
        </select>
        <label class="admin-check">
          <input type="checkbox" data-user-select-all>
          <span>全选本页</span>
        </label>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table admin-table--cards">
          <thead>
            <tr>
              <th class="admin-table__pick"></th>
              <th>昵称 / ID</th><th>邮箱</th><th>邮箱状态</th><th>状态</th><th>角色</th>
              <th>改稿权限</th><th>两步验证</th><th>发布数</th><th>互动</th><th>注册时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody data-admin-users>
            <tr><td colspan="12" class="admin-empty">加载中…</td></tr>
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

  <!-- ==================== 垃圾评论（B17） ==================== -->
  <section class="admin-panel" data-admin-panel="spam" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">反垃圾队列</h2>
        <span class="panel__hint">
          按可疑度从高到低排。评分只做<strong>提示</strong>：达到「直接隐藏」阈值的会自动隐藏，
          其余仍进待审 —— 机器判错了不会直接毁掉一条正常评论
        </span>
      </div>
      <div class="admin-toolbar admin-toolbar--wrap">
        <span class="panel__hint">
          当前阈值：<strong data-spam-hold>4</strong> 分进待审、
          <strong data-spam-hide>7</strong> 分自动隐藏（在「站点设置」里改）
        </span>
        <label class="admin-check">
          <input type="checkbox" data-spam-select-all>
          <span>全选本页</span>
        </label>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table admin-table--cards">
          <thead>
            <tr><th class="admin-table__pick"></th><th>作者 / 文章</th><th>内容</th><th>判定</th><th>来源</th><th>操作</th></tr>
          </thead>
          <tbody data-admin-spam>
            <tr><td colspan="6" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-spam-pager></div>
    </div>
  </section>

  <!-- ==================== 媒体库（B7） ==================== -->
  <section class="admin-panel" data-admin-panel="media" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">媒体库</h2>
        <span class="panel__hint">
          共 <span data-media-total>0</span> 个文件，占用 <span data-media-size>0 B</span>
        </span>
        <div class="panel__head-actions">
          <button class="btn btn--primary btn--sm" type="button" data-media-upload>上传图片</button>
        </div>
      </div>
      <div class="admin-toolbar">
        <input class="field__input" type="search" placeholder="搜索文件名 / 路径" data-media-search>
        <select class="field__input field__input--select" data-media-folder>
          <option value="">全部分组</option>
        </select>
      </div>
      <p class="admin-hint-line">
        上传前会按当前分组自动归档；缩略图直接用公开地址，不额外占空间。
        已在编辑器里插入过的图片也会在下次上传同名文件时自动登记。
      </p>
      <div class="media-grid" data-media-grid>
        <div class="admin-empty">加载中…</div>
      </div>
      <div class="admin-pager" data-media-pager></div>
    </div>
  </section>

  <!-- ==================== 统计与访问（B9 / B10） ==================== -->
  <section class="admin-panel" data-admin-panel="stats" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">增长趋势</h2>
        <div class="panel__head-actions">
          <select class="field__input field__input--select" data-stats-days>
            <option value="7">最近 7 天</option>
            <option value="30" selected>最近 30 天</option>
            <option value="90">最近 90 天</option>
            <option value="180">最近 180 天</option>
          </select>
        </div>
      </div>
      <div class="chart-box" data-stats-chart>
        <p class="chart-empty">加载中…</p>
      </div>
      <div class="admin-stats">
        <div class="admin-stat"><div class="admin-stat__value" data-trend-comments>0</div><div class="admin-stat__label">区间新增评论</div></div>
        <div class="admin-stat"><div class="admin-stat__value" data-trend-posts>0</div><div class="admin-stat__label">区间新增文章</div></div>
        <div class="admin-stat"><div class="admin-stat__value" data-trend-views>0</div><div class="admin-stat__label">区间浏览量</div></div>
        <div class="admin-stat"><div class="admin-stat__value" data-trend-users>0</div><div class="admin-stat__label">区间新增用户</div></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">热门文章</h2>
        <span class="panel__hint">按累计浏览量排序</span>
      </div>
      <div class="chart-box" data-top-posts>
        <p class="chart-empty">加载中…</p>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">访问分析</h2>
        <span class="panel__hint">PV / UV 均剔除机器人，同会话 30 分钟内同一路径只计一次</span>
      </div>
      <div class="admin-stats">
        <div class="admin-stat"><div class="admin-stat__value" data-an-pv>0</div><div class="admin-stat__label">浏览量 PV</div></div>
        <div class="admin-stat"><div class="admin-stat__value" data-an-uv>0</div><div class="admin-stat__label">访客数 UV</div></div>
        <div class="admin-stat"><div class="admin-stat__value" data-an-bot>0</div><div class="admin-stat__label">机器人请求</div></div>
      </div>
      <div class="chart-grid">
        <div class="chart-card">
          <h3 class="chart-card__title">PV / UV 走势</h3>
          <div class="chart-box" data-an-series></div>
        </div>
        <div class="chart-card">
          <h3 class="chart-card__title">热门页面</h3>
          <div class="chart-box" data-an-paths></div>
        </div>
        <div class="chart-card">
          <h3 class="chart-card__title">来源站点</h3>
          <div class="chart-box" data-an-referrers></div>
        </div>
        <div class="chart-card">
          <h3 class="chart-card__title">访客环境</h3>
          <div class="chart-box" data-an-uas></div>
        </div>
      </div>
      <p class="admin-hint-line">
        只记录路径、来源域名、浏览器大类与一个按日轮换的会话指纹；不存 IP、不存完整 UA、不写 Cookie。
      </p>
    </div>
  </section>

  <!-- ==================== 站点设置（B6 / B15 / B16） ==================== -->
  <section class="admin-panel" data-admin-panel="settings" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">站点标识</h2>
        <span class="panel__hint">
          这里改的是<strong>运行期</strong>的公开信息（公告条、维护模式立刻生效）；
          站点标题等会同时写进下次构建，需要重新部署才会替换 HTML 里的静态文案
        </span>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="field__label">站点标题</span>
          <input class="field__input" type="text" data-set="site.title" maxlength="60">
        </label>
        <label class="field">
          <span class="field__label">副标题 / 标语</span>
          <input class="field__input" type="text" data-set="site.tagline" maxlength="80">
        </label>
        <label class="field field--full">
          <span class="field__label">站点描述（用于搜索引擎摘要）</span>
          <input class="field__input" type="text" data-set="site.description" maxlength="200">
        </label>
        <label class="field field--full">
          <span class="field__label">关键词（逗号分隔）</span>
          <input class="field__input" type="text" data-set="site.keywords" maxlength="200">
        </label>
        <label class="field">
          <span class="field__label">备案号</span>
          <input class="field__input" type="text" data-set="site.footer_icp" maxlength="60">
        </label>
        <label class="field">
          <span class="field__label">联系邮箱</span>
          <input class="field__input" type="email" data-set="contact.email" maxlength="120">
        </label>
      </div>
      <div class="form-grid__foot">
        <button class="btn btn--primary btn--sm" type="button" data-settings-save>保存站点标识</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">公告条</h2>
        <span class="panel__hint">出现在全站页头下方，读者可单独关闭；保存后立即生效，无需重新部署</span>
      </div>
      <div class="form-grid">
        <label class="field field--switch">
          <input type="checkbox" data-set-flag="banner.announcement" data-key="active">
          <span class="field__label">启用公告条</span>
        </label>
        <label class="field">
          <span class="field__label">语气</span>
          <select class="field__input field__input--select" data-set="banner.announcement" data-key="level">
            <option value="info">普通提示</option>
            <option value="warn">警告 / 变更</option>
            <option value="success">好消息</option>
          </select>
        </label>
        <label class="field field--full">
          <span class="field__label">公告正文（一句话，别写成小作文）</span>
          <input class="field__input" type="text" data-set="banner.announcement" data-key="text" maxlength="200">
        </label>
      </div>
      <div class="form-grid__foot">
        <button class="btn btn--primary btn--sm" type="button" data-settings-save>保存公告条</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">维护模式</h2>
        <span class="panel__hint">
          打开后全站盖一层遮罩。管理员带 <code>?maintenance=off</code> 可自行绕过（服务端会确认身份）
        </span>
      </div>
      <div class="form-grid">
        <label class="field field--switch">
          <input type="checkbox" data-set-flag="banner.maintenance" data-key="active">
          <span class="field__label">进入维护模式</span>
        </label>
        <label class="field field--switch">
          <input type="checkbox" data-set-flag="banner.maintenance" data-key="allow_admin">
          <span class="field__label">允许管理员绕过</span>
        </label>
        <label class="field field--full">
          <span class="field__label">给读者看的话</span>
          <input class="field__input" type="text" data-set="banner.maintenance" data-key="message" maxlength="200">
        </label>
      </div>
      <div class="form-grid__foot">
        <button class="btn btn--primary btn--sm" type="button" data-settings-save>保存维护模式</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">评论风控阈值</h2>
        <span class="panel__hint">改完立刻影响新评论的打分判定（历史评论的分数不会重算）</span>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="field__label">进待审的分数（默认 4）</span>
          <input class="field__input" type="number" min="0" max="20" data-set-num="comment.hold_score">
        </label>
        <label class="field">
          <span class="field__label">自动隐藏的分数（默认 7）</span>
          <input class="field__input" type="number" min="0" max="20" data-set-num="comment.auto_hide_score">
        </label>
      </div>
      <div class="form-grid__foot">
        <button class="btn btn--primary btn--sm" type="button" data-settings-save>保存阈值</button>
      </div>
    </div>
  </section>

  <!-- ==================== 通知与邮件（B3 / B16） ==================== -->
  <section class="admin-panel" data-admin-panel="notify" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">站外通知</h2>
        <span class="panel__hint">
          站内通知始终照常发；打开这里之后，通知会<strong>再</strong>投递一份到 Webhook（邮件 / 群机器人 / 自建服务都行）。
          投递由云函数 ws-notify 定时执行，没部署也不影响站内通知
        </span>
      </div>
      <div class="form-grid">
        <label class="field field--switch">
          <input type="checkbox" data-set-bool="notify.enabled">
          <span class="field__label">启用站外投递</span>
        </label>
        <label class="field">
          <span class="field__label">送达方式</span>
          <select class="field__input field__input--select" data-set="notify.webhook_kind">
            <option value="auto">自动识别（按 URL 判断）</option>
            <option value="json">通用 JSON POST</option>
            <option value="wecom">企业微信群机器人</option>
            <option value="dingtalk">钉钉群机器人</option>
            <option value="feishu">飞书群机器人</option>
          </select>
        </label>
        <label class="field field--full">
          <span class="field__label">Webhook 地址</span>
          <input class="field__input mono" type="text" data-set="notify.webhook_url" maxlength="300"
                 placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…">
        </label>
        <div class="field field--full">
          <span class="field__label">投递密钥（云函数用它领取待发消息）</span>
          <div class="inline-form inline-form--tight">
            <input class="field__input mono" type="text" data-set="notify.worker_secret" maxlength="80"
                   placeholder="至少 16 位随机串">
            <button class="btn btn--ghost btn--sm" type="button" data-notify-gen-secret>随机生成</button>
            <button class="btn btn--ghost btn--sm" type="button" data-notify-copy-secret>复制</button>
          </div>
          <span class="field__hint">
            这个密钥等于投递通道的口令，别贴到公开仓库。函数侧用同一个值调用
            <code>notify_outbox_claim</code> 领取、<code>notify_outbox_ack</code> 回执。
          </span>
        </div>
        <div class="field field--full">
          <span class="field__label">要推送哪些事件</span>
          <div class="chip-row" data-notify-kinds>
            <label class="admin-check"><input type="checkbox" value="comment"><span>新评论</span></label>
            <label class="admin-check"><input type="checkbox" value="submission"><span>新投稿</span></label>
            <label class="admin-check"><input type="checkbox" value="report"><span>评论举报</span></label>
            <label class="admin-check"><input type="checkbox" value="email_request"><span>邮箱变更申请</span></label>
            <label class="admin-check"><input type="checkbox" value="mention"><span>被 @ 提及</span></label>
          </div>
        </div>
      </div>
      <div class="form-grid__foot">
        <button class="btn btn--primary btn--sm" type="button" data-settings-save>保存站外通知</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">邮件 / 消息模板</h2>
        <span class="panel__hint">
          用 <code>{'{'}</code>变量<code>{'}'}</code> 占位，可用：site / title / author / excerpt / link / target / post
        </span>
      </div>
      <div class="admin-subtabs" role="tablist" aria-label="模板选择">
        <button class="admin-subtab is-active" type="button" role="tab" aria-selected="true" data-tpl-tab="mail.tpl.comment">新评论</button>
        <button class="admin-subtab" type="button" role="tab" aria-selected="false" data-tpl-tab="mail.tpl.submission">新投稿</button>
        <button class="admin-subtab" type="button" role="tab" aria-selected="false" data-tpl-tab="mail.tpl.report">举报</button>
        <button class="admin-subtab" type="button" role="tab" aria-selected="false" data-tpl-tab="mail.tpl.email_request">邮箱申请</button>
        <button class="admin-subtab" type="button" role="tab" aria-selected="false" data-tpl-tab="mail.tpl.system">系统通知</button>
      </div>
      <div class="form-grid">
        <label class="field field--full">
          <span class="field__label">标题</span>
          <input class="field__input" type="text" data-tpl-subject maxlength="200">
        </label>
        <label class="field field--full">
          <span class="field__label">正文（支持换行）</span>
          <textarea class="field__input field__textarea mono" rows="6" data-tpl-body></textarea>
        </label>
      </div>
      <div class="form-grid__foot">
        <button class="btn btn--primary btn--sm" type="button" data-tpl-save>保存这个模板</button>
        <button class="btn btn--ghost btn--sm" type="button" data-tpl-reset>恢复默认</button>
        <span class="write-status" data-tpl-status aria-live="polite"></span>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">投递队列</h2>
        <span class="panel__hint">
          待发 <strong data-outbox-pending>0</strong> ·
          失败 <strong data-outbox-failed>0</strong> ·
          已送达 <strong data-outbox-sent>0</strong>
        </span>
        <div class="panel__head-actions">
          <button class="btn btn--ghost btn--sm" type="button" data-outbox-retry-all>全部重试</button>
        </div>
      </div>
      <div class="admin-toolbar">
        <div class="chip-row">
          <button class="chip is-active" type="button" data-outbox-filter="all">全部</button>
          <button class="chip" type="button" data-outbox-filter="pending">待发</button>
          <button class="chip" type="button" data-outbox-filter="failed">失败</button>
          <button class="chip" type="button" data-outbox-filter="sent">已送达</button>
        </div>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>时间</th><th>类型</th><th>标题</th><th>状态</th><th>重试</th><th>操作</th></tr></thead>
          <tbody data-admin-outbox>
            <tr><td colspan="6" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-outbox-pager></div>
    </div>
  </section>

  <!-- ==================== 数据与备份（B5） ==================== -->
  <section class="admin-panel" data-admin-panel="data" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">导出数据</h2>
        <span class="panel__hint">生成 JSON 直接下载；单表上限 5000 行，够用来做备份和对账</span>
      </div>
      <div class="admin-toolbar">
        <select class="field__input field__input--select" data-export-kind>
          <option value="all">全部</option>
          <option value="posts">文章</option>
          <option value="comments">评论</option>
          <option value="users">用户</option>
          <option value="interactions">互动（点赞/收藏/阅读/订阅）</option>
          <option value="admin">审计日志 + 站点设置</option>
        </select>
        <button class="btn btn--primary btn--sm" type="button" data-export-run>导出并下载</button>
        <button class="btn btn--ghost btn--sm" type="button" data-export-to-cloud>导出并存为云端备份</button>
      </div>
      <p class="admin-hint-line">
        导出走的是服务端只读函数，只有管理员能调用；用户导出里<strong>不含密码哈希</strong>，
        只有资料、状态与互动计数。
      </p>
      <div class="admin-table-wrap" data-export-preview hidden>
        <table class="admin-table">
          <thead><tr><th>数据集</th><th>行数</th></tr></thead>
          <tbody data-export-tbody></tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">备份快照</h2>
        <span class="panel__hint">每次「导出并存为云端备份」都会在这里留一条记录，可下载或删除</span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>时间</th><th>范围</th><th>文件</th><th>大小</th><th>操作</th></tr></thead>
          <tbody data-backup-list>
            <tr><td colspan="5" class="admin-empty">加载中…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="admin-pager" data-backup-pager></div>
    </div>
  </section>

  <!-- ==================== 安全与健康（B13 / B14） ==================== -->
  <section class="admin-panel" data-admin-panel="system" hidden>
    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">二次验证（TOTP）</h2>
        <span class="panel__hint">
          开启后，改站点设置、批量删除、删备份、禁用用户等敏感操作都需要先输入 6 位动态码
          （15 分钟内免重复输入）
        </span>
      </div>
      <div class="twofa" data-twofa>
        <div class="twofa__state">
          <span class="twofa__dot" data-twofa-dot></span>
          <span data-twofa-state>检查中…</span>
        </div>
        <div class="twofa__actions" data-twofa-actions></div>
        <div class="twofa__setup" data-twofa-setup hidden>
          <p>用任意验证器（Google Authenticator / 1Password / 微信小程序「验证码」等）扫码，或手工输入密钥：</p>
          <div class="twofa__secret">
            <code data-twofa-secret></code>
            <button class="btn btn--ghost btn--xs" type="button" data-twofa-copy>复制密钥</button>
          </div>
          <div class="inline-form inline-form--tight">
            <input class="field__input mono" type="text" inputmode="numeric" maxlength="6"
                   placeholder="输入 6 位动态码" data-twofa-code>
            <button class="btn btn--primary btn--sm" type="button" data-twofa-enable>确认开启</button>
          </div>
        </div>
        <p class="admin-hint-line">
          密钥只存服务端、不下发到页面，页面里只在你开启的那一次显示。
          换手机或丢了验证器，可以让另一位管理员在「用户」里重置。
        </p>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head">
        <h2 class="panel__title">站点健康</h2>
        <div class="panel__head-actions">
          <span class="panel__hint" data-health-time></span>
          <button class="btn btn--ghost btn--sm" type="button" data-health-refresh>重新检查</button>
        </div>
      </div>
      <div class="health-grid" data-health-grid>
        <div class="admin-empty">加载中…</div>
      </div>
      <div class="health-attention" data-health-attention hidden>
        <h3 class="chart-card__title">需要留意</h3>
        <ul class="health-list" data-health-attention-list></ul>
      </div>
      <div class="health-latest" data-health-latest hidden>
        <h3 class="chart-card__title">最近记录</h3>
        <ul class="health-list" data-health-latest-list></ul>
      </div>
    </div>
  </section>
</div>"""


# ---------- 在线文章（云端）----------

# ---------- 系列（V7） ----------

def series_index_page(*, config: dict, series: list, root: str = "") -> str:
    """系列总览：所有系列 + 每个系列的文章数。"""
    lang = _lang(config)
    cards = "".join(
        f'<a class="series-card" href="{root}series/{esc(item["slug"])}.html">'
        f'<span class="series-card__name">{esc(item["name"])}</span>'
        f'<span class="series-card__meta">{esc(T("series.count", lang, n=item["count"]))}'
        f' · {_short_date(item["latest"])}</span></a>'
        for item in series
    )
    body = cards or f'<div class="empty-state" data-i18n="series.empty">{esc(T("series.empty", lang))}</div>'

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("series.title", lang), None, "series.title")], root=root)}
    <span class="eyebrow">Series</span>
    <h1 class="article-head__title" style="margin-top:14px" data-i18n="series.title">{esc(T("series.title", lang))}</h1>
    <p class="article-head__summary" style="margin-top:18px" data-i18n="series.summary">{esc(T("series.summary", lang))}</p>
  </div>
  <section class="section">
    <div class="series-grid">{body}</div>
  </section>
</div>"""


def series_page(*, config: dict, item: dict, root: str = "../") -> str:
    """单个系列：按发布时间**升序**列出（连载要能顺着读）。"""
    lang = _lang(config)
    steps = []
    for index, post in enumerate(item["posts"], start=1):
        steps.append(
            f'<li class="series-step">'
            f'<span class="series-step__index" aria-hidden="true">{index}</span>'
            f'<div class="series-step__body">'
            f'<div class="series-step__date">{_short_date(post["date"])}'
            f' · {post.get("reading_time", "")} <span data-i18n="common.minutes">{esc(T("common.minutes", lang))}</span></div>'
            f'<h3 class="series-step__title"><a class="stretch-link" href="{root}{post["url"]}">{esc(post["title"])}</a></h3>'
            f'<p class="series-step__summary">{esc(post["summary"])}</p>'
            f"</div></li>"
        )

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav(
        [_crumb_home(config), (T("series.title", lang), "series.html", "series.title"), (str(item["name"]), None)],
        root=root,
    )}
    <span class="eyebrow">Series</span>
    <h1 class="article-head__title" style="margin-top:14px">{esc(item["name"])}</h1>
    <p class="article-head__summary" style="margin-top:18px">{esc(T("series.summary", lang))}
      <span class="series-page__count">{esc(T("series.count", lang, n=item["count"]))}</span></p>
  </div>
  <section class="section">
    <ol class="series-steps">{"".join(steps)}</ol>
  </section>
</div>"""


# ---------- 快捷键（V17） ----------

def shortcuts_page(*, config: dict, root: str = "") -> str:
    """快捷键说明页：把这些键位从「藏起来的用法」变成可发现的文档。"""
    lang = _lang(config)

    def _row(keys, key_id: str) -> str:
        kbd = "".join(f"<kbd>{esc(key)}</kbd>" for key in keys)
        return f'<div class="shortcut-row"><div class="shortcut-row__keys">{kbd}</div>' \
               f'<div class="shortcut-row__label" data-i18n="{key_id}">{esc(T(key_id, lang))}</div></div>'

    rows = "".join(
        [
            _row(["/"], "shortcuts.open"),
            _row(["Ctrl", "K"], "shortcuts.openAlt"),
            _row(["?"], "shortcuts.thisPage"),
            _row(["ESC"], "shortcuts.close"),
            _row(["↑", "↓"], "shortcuts.navigate"),
            _row(["↵"], "shortcuts.enter"),
            _row(["Home"], "shortcuts.toTop"),
        ]
    )

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("shortcuts.title", lang), None, "shortcuts.title")], root=root)}
    <span class="eyebrow">Shortcuts</span>
    <h1 class="article-head__title" style="margin-top:14px" data-i18n="shortcuts.title">{esc(T("shortcuts.title", lang))}</h1>
    <p class="article-head__summary" style="margin-top:18px" data-i18n="shortcuts.lead">{esc(T("shortcuts.lead", lang))}</p>
  </div>
  <section class="section">
    <div class="shortcuts" data-shortcuts>{rows}</div>
    <p class="list-note" data-i18n="shortcuts.tip">{esc(T("shortcuts.tip", lang))}</p>
  </section>
</div>"""


# ---------- 订阅（V11） ----------

def subscribe_page(*, config: dict, root: str = "", cloud: bool = True) -> str:
    """订阅页：RSS 立刻可用；邮件订阅登记进 subscribers 表。

    ⚠️ 站点当前**没有接入发信服务**，所以表单项的文案如实说明「先登记、
    接入后开始投递」，不假装已经会发信。退订令牌与状态字段已经在表里准备好
    （见 cloud/sql/2026-10-13-batch5-visitor-gaps.sql）。
    """
    lang = _lang(config)
    site_title = esc(config.get("title") or "Blog")
    feed_url = f"{root}feed.xml"

    email_form = ""
    if cloud:
        email_form = f"""<form class="subscribe-form" data-subscribe-form novalidate>
    <label class="subscribe-form__label" for="subscribe-email" data-i18n="subscribe.emailTitle">{esc(T("subscribe.emailTitle", lang))}</label>
    <p class="subscribe-form__desc" data-i18n="subscribe.emailDesc">{esc(T("subscribe.emailDesc", lang))}</p>
    <div class="subscribe-form__row">
      <input class="subscribe-form__input" id="subscribe-email" type="email" name="email" required
             autocomplete="email" inputmode="email" spellcheck="false"
             placeholder="{esc(T("subscribe.emailPlaceholder", lang))}"
             data-i18n-attr="placeholder:subscribe.emailPlaceholder" data-subscribe-input>
      <button class="btn btn--primary" type="submit" data-subscribe-submit>
        <span data-i18n="subscribe.emailSubmit">{esc(T("subscribe.emailSubmit", lang))}</span></button>
    </div>
    <p class="subscribe-form__status" data-subscribe-status role="status" aria-live="polite"></p>
  </form>"""

    return f"""<div class="wrap">
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("subscribe.title", lang), None, "subscribe.title")], root=root)}
    <span class="eyebrow">Subscribe</span>
    <h1 class="article-head__title" style="margin-top:14px" data-i18n="subscribe.title">{esc(T("subscribe.title", lang))}</h1>
    <p class="article-head__summary" style="margin-top:18px" data-i18n="subscribe.lead">{esc(T("subscribe.lead", lang))}</p>
  </div>
  <section class="section subscribe">
    <div class="subscribe__col">
      <h2 class="subscribe__title" data-i18n="subscribe.rssTitle">{esc(T("subscribe.rssTitle", lang))}</h2>
      <p class="subscribe__desc" data-i18n="subscribe.rssDesc">{esc(T("subscribe.rssDesc", lang))}</p>
      <p class="subscribe__feed mono">{esc(feed_url)}</p>
      <div class="subscribe__actions">
        <button class="btn btn--ghost" type="button" data-copy-value="{esc(config.get("url") or "")}/feed.xml"
                data-i18n="subscribe.rssCopy">{esc(T("subscribe.rssCopy", lang))}</button>
        <a class="btn btn--ghost" href="{feed_url}">{icons["rss"]}<span data-i18n="subscribe.rssOpen">{esc(T("subscribe.rssOpen", lang))}</span></a>
      </div>
    </div>
    <div class="subscribe__col">
      {email_form}
    </div>
  </section>
  <p class="list-note" data-i18n="subscribe.privacyNote">{esc(T("subscribe.privacyNote", lang))}</p>
</div>"""


def cloud_posts_page(*, config: dict, root: str = "") -> str:
    lang = _lang(config)
    return f"""<div class="wrap" data-cloud-posts>
  <div class="page-head">
    {breadcrumb_nav([_crumb_home(config), (T("cloudPosts.title", lang), None, "cloudPosts.title")], root=root)}
    <span class="eyebrow">Online</span>
    <h1 class="article-head__title" style="margin-top:14px" data-i18n="cloudPosts.title">{esc(T("cloudPosts.title", lang))}</h1>
    <p class="article-head__summary" style="margin-top:18px">
      <span data-i18n="cloudPosts.lead">{esc(T("cloudPosts.lead", lang))}</span>
      <span data-cloud-count>0</span> <span data-i18n="cloudPosts.unit">{esc(T("cloudPosts.unit", lang))}</span>
    </p>
    <div class="hero__actions" style="margin-top:24px">
      <a class="btn btn--ghost btn--sm" href="{root}write.html" data-i18n="cloudPosts.writeCta">{esc(T("cloudPosts.writeCta", lang))}</a>
    </div>
  </div>
  <section class="section" style="margin-top:44px">
    <div class="loading-state" data-cloud-status data-i18n="common.loading">{esc(T("common.loading", lang))}</div>
    <ul class="post-list" data-cloud-post-list></ul>
    <div class="empty-state" data-cloud-empty hidden data-i18n="cloudPosts.empty">{esc(T("cloudPosts.empty", lang))}</div>
    <nav class="pagination" aria-label="{esc(T("cloudPosts.pagination", lang))}" data-i18n-attr="aria-label:cloudPosts.pagination" data-cloud-pagination hidden></nav>
  </section>
</div>"""


def cloud_post_page(*, config: dict, root: str = "") -> str:
    lang = _lang(config)
    # 云文章标题要等客户端拿到文章才有，这里先留一个空节点由 cloud-posts.js 回填。
    # ⚠️ 下面这段注释不能写进 f-string 的表达式里：Python < 3.12 不允许表达式内含 '#'，
    #    而部署沙箱的 Python 版本比本地低（本地 3.13 能过、沙箱直接 SyntaxError）。
    crumb_extra = (
        '<span class="breadcrumb__sep">/</span>'
        '<span aria-current="page" data-cloud-crumb hidden></span>'
    )
    return f"""<div class="wrap" data-cloud-post>
  <div class="page-head">
    {breadcrumb_nav(
        [_crumb_home(config), (T("cloudPosts.title", lang), "posts.html", "cloudPosts.title")],
        root=root,
        extra=crumb_extra,
    )}
    <header class="article-head" data-cloud-head>
      <span class="eyebrow">Online</span>
      <h1 class="article-head__title" data-i18n="common.loading">{esc(T("common.loading", lang))}</h1>
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
  {post_interact_block(post_slug="", post_title="", root=root, login_next="posts.html", lang=lang)}
</div>"""


def preview_page(*, config: dict, root: str = "") -> str:
    """A4 草稿预览分享页：凭 token 读一份内容快照，无需登录。

    刻意做成**纯客户端渲染**：token 是随机的、文章可能还没发布，
    静态化没有意义，反而会把未公开正文写进产物目录。
    """
    lang = _lang(config)
    return f"""<div class="wrap" data-preview data-preview-root="{root}">
  <div class="preview-banner">
    <span class="preview-banner__mark" aria-hidden="true">👀</span>
    <div class="preview-banner__text">
      <strong>这是一条预览链接</strong>
      <span>内容是提交时的快照，<em>尚未公开发布</em>；对方看到的不是线上版本。请勿转发给无关的人。</span>
    </div>
  </div>

  <div class="loading-state" data-preview-status>正在读取预览内容…</div>

  <div class="preview-body" data-preview-body hidden>
    <header class="article-head">
      <span class="eyebrow">Preview</span>
      <h1 class="article-head__title" data-preview-title></h1>
      <p class="article-head__summary" data-preview-summary hidden></p>
      <div class="article-meta">
        <span data-preview-author></span>
        <span data-preview-expiry></span>
      </div>
      <div class="tag-row" data-preview-tags></div>
    </header>
    <article class="prose" data-preview-content></article>
  </div>

  <div class="empty-state" data-preview-error hidden>
    <h2>预览链接不可用</h2>
    <p data-preview-error-text>链接可能已过期、被撤销，或地址不完整。</p>
    <a class="btn btn--ghost btn--sm" href="{root}index.html">回到首页</a>
  </div>
</div>"""


# 预览页不该被搜索引擎收录：它是「一人一条随机链接」的临时页面，
# 收录了既没意义，也可能把作者还没定稿的内容带进索引。
PREVIEW_NOINDEX = '<meta name="robots" content="noindex, nofollow">'
