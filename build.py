#!/usr/bin/env python
"""WS Blog · 静态站点生成器（Python 版）

用法：
  python build.py                     生成 dist/
  python build.py --serve             生成并启动本地预览服务器（含自动重建）
  python build.py --drafts            连草稿一起生成
  python build.py --new post "标题"    新建一篇文章
  python build.py --new project "项目"  新建一个项目
  python build.py --clean             先清空 dist/ 再生成
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
from datetime import datetime

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

# Windows 控制台默认不是 UTF-8，中文日志会炸，这里显式兜底
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

from wsblog.cloudconf import (  # noqa: E402
    build_cloud_config_js,
    cloud_enabled,
    load_cloud_config,
    vendor_url,
)
from wsblog.cloudposts import (  # noqa: E402
    cloud_posts_fingerprint,
    fetch_public_profiles,
    fetch_published_cloud_posts,
)
from wsblog.cloudsettings import (  # noqa: E402
    announcement_of,
    fetch_public_settings,
    maintenance_of,
    publish_due_posts,
    site_identity_of,
)
from wsblog.cloudstats import (  # noqa: E402
    apply_stats,
    fetch_post_stats,
    fetch_recent_comments,
    interact_key,
)
from wsblog.content import (  # noqa: E402
    collect_series,
    collect_tags,
    load_page,
    load_posts,
    load_projects,
)
from wsblog.i18n import T, build_i18n_js, normalize_lang  # noqa: E402
from wsblog.server import serve  # noqa: E402
from wsblog.templates.layout import layout  # noqa: E402
from wsblog.templates.pages import (  # noqa: E402
    about_page,
    account_page,
    admin_page,
    archive_page,
    author_page,
    cloud_post_page,
    cloud_posts_page,
    home_page,
    login_page,
    not_found_page,
    notifications_page,
    offline_page,
    page_url,
    paginate,
    post_page,
    PREVIEW_NOINDEX,
    preview_page,
    project_detail_page,
    projects_page,
    related_posts_block,
    series_index_page,
    series_page,
    shortcuts_page,
    subscribe_page,
    tag_page,
    tags_page,
    write_page,
)
from wsblog.util import escape_html as esc  # noqa: E402
from wsblog.util import iso_date, root_prefix, slugify, truncate, utc_string  # noqa: E402

SRC_DIR = os.path.join(ROOT_DIR, "src")
CONTENT_DIR = os.path.join(ROOT_DIR, "content")
DIST_DIR = os.path.join(ROOT_DIR, "dist")
CONFIG_FILE = os.path.join(ROOT_DIR, "site.config.json")

# 需要拷贝到 dist/assets/ 的浏览器端脚本（手写文件；生成物由 build 直接 write）
ASSET_SCRIPTS = (
    "theme.js",
    "app.js",
    "banner.js",       # B15 站内公告 / 维护模式（全局）
    "analytics.js",    # B10 访问上报（全局，公开页埋点）
    "math.js",
    "cloud.js",
    "notify.js",
    "cloud-markdown.js",
    "auth.js",
    "interact.js",
    "account.js",
    "notifications.js",
    "draft.js",
    "write.js",
    "write-ext.js",    # A3/A4/A5 投稿页的定时 / 预览链接 / 修订历史
    "preview.js",      # A4 预览分享页（preview.html）
    "chart.js",        # B9 零依赖 SVG 图表（后台统计）
    "admin.js",
    "admin-ext.js",    # B2–B17 新增面板（批量 / 垃圾 / 媒体 / 统计 / 设置 / 通知 / 备份 / 健康）
    "cloud-posts.js",
    "upload.js",
    "avatar-crop.js",
    "onboard.js",
    "subscribe.js",
)

_ANCHOR_RE = re.compile(r"<a\s|</a>")

nested_anchor_issues: list[str] = []


# ---------------- 文件工具 ----------------

_prepared_dirs: set[str] = set()


def ensure_dir(directory: str) -> None:
    """建目录并记住结果，避免每个文件都重复一次系统调用。"""
    if directory in _prepared_dirs:
        return
    os.makedirs(directory, exist_ok=True)
    _prepared_dirs.add(directory)


def write(rel_path: str, content: str) -> str:
    target = os.path.join(DIST_DIR, rel_path)
    ensure_dir(os.path.dirname(target))
    with open(target, "w", encoding="utf-8", newline="") as handle:
        handle.write(content)
    if rel_path.endswith(".html"):
        check_nested_anchors(rel_path, content)
    return target


def copy_file(source: str, rel_path: str) -> str:
    target = os.path.join(DIST_DIR, rel_path)
    ensure_dir(os.path.dirname(target))
    shutil.copyfile(source, target)
    return target


def read_config() -> dict:
    with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
        raw = handle.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"site.config.json 解析失败：{exc}") from exc


def check_nested_anchors(rel_path: str, html: str) -> None:
    """检查 HTML 中是否存在嵌套的 <a> 标签。

    HTML 不允许锚点嵌套，浏览器解析器会按「收养算法」把外层锚点拆散，
    导致布局错乱 —— 这类问题在源码里很难看出来，必须在构建时拦住。
    """
    depth = 0
    for matched in _ANCHOR_RE.finditer(html):
        if matched.group(0) == "</a>":
            depth = max(0, depth - 1)
            continue
        if depth > 0:
            start = max(0, matched.start() - 60)
            context = re.sub(r"\s+", " ", html[start : matched.start() + 60])
            print(f"⚠ {rel_path}：检测到嵌套的 <a> 标签（HTML 不允许），附近内容：…{context}…")
            nested_anchor_issues.append(rel_path)
        depth += 1


# ---------------- 构建 ----------------

def _is_http_url(url) -> bool:
    """只认绝对的 http(s) 地址：本地相对路径塞进 og:image / JSON-LD image 会翻车。"""
    return str(url or "").strip().lower().startswith(("http://", "https://"))


def _math_scripts(*sources) -> list:
    """页面真的出现公式 / Mermaid 图时才注入 math.js（V12）。

    KaTeX 与 Mermaid 加起来 2.8 MB，宁可让 math.js 按需去拉，也不要让
    每篇文章都背上这个代价；没有公式的页面连 math.js 这点体积都省下来。
    """
    for source in sources:
        if source and (source.get("has_math") or source.get("has_mermaid")):
            return ["math.js"]
    return []


def _author_for_post(post: dict, authors_by_id: dict) -> dict | None:
    """文章详情页的署名：只有该作者建了公开主页才返回（否则宁可不署名）。"""
    author_id = str(post.get("author_id") or "")
    author = authors_by_id.get(author_id) if author_id else None
    if not author:
        return None
    return {
        "name": author["name"],
        "url": author["url"],
        "avatar_url": author["avatar_url"],
    }


def build(include_drafts: bool = False, clean: bool = False) -> dict:
    started = time.perf_counter()
    config = read_config()
    nested_anchor_issues.clear()

    cloud = cloud_enabled()
    site_origin = str(config.get("siteOrigin") or "").rstrip("/")
    if cloud and not site_origin:
        # 云服务按 Origin 校验请求，这里兜底用站点 url，正式部署时应显式配置
        site_origin = str(config.get("url") or "").rstrip("/")

    # 站点默认界面语言：构建期的静态文案（<title> / meta description）用它，
    # 页内的可切换文案由 assets/i18n.js 在浏览器里替换
    lang = normalize_lang(config.get("lang"))

    if clean and os.path.isdir(DIST_DIR):
        shutil.rmtree(DIST_DIR)
        print("· 已清空 dist/")

    os.makedirs(DIST_DIR, exist_ok=True)

    posts = [post for post in load_posts(CONTENT_DIR, include_drafts) if include_drafts or not post["draft"]]
    posts.sort(key=lambda post: (0 if post["pinned"] else 1, -post["date"].timestamp()))

    # --- 云端已发布文章（构建期拉取，与静态文章合流）---
    # 后台发的文章只存在于 cloud_posts 表；这里把它们拉下来归一化成与静态文章
    # 同形的 dict，合并进首页 / 标签 / 搜索 / RSS / sitemap，让两套内容在全站
    # 所有入口上保持一致。拉取失败自动降级（本次构建少一批在线文章，不报错）。
    cloud_posts: list[dict] = []
    public_profiles: dict[str, dict] = {}
    publishable_key = str(load_cloud_config().get("publishableKey") or "")
    if cloud:
        # A3 定时发布：把已到点的 scheduled 文章翻成 published（幂等）。
        # posts_public 视图本身已经做了「publish_at <= now() 即可见」的兜底，
        # 这一步只是把状态归正、并顺带触发「已发布」通知。失败不阻断构建。
        publish_due_posts(site_origin=site_origin, publishable_key=publishable_key)        # 把静态文章的 slug 传给云端归一化：云文章落静态详情页时若与静态
        # 文章撞名，自动退回 post.html?slug=（客户端渲染兜底）
        cloud_posts = fetch_published_cloud_posts(
            site_origin=site_origin,
            publishable_key=publishable_key,
            static_slugs={post["slug"] for post in posts},
        )
        # 公开作者资料：给云文章补署名、并驱动作者主页
        public_profiles = fetch_public_profiles(
            site_origin=site_origin,
            publishable_key=publishable_key,
        )

    # --- B15 站点公开设置（公告条 / 维护模式 / 站点标识）---
    # 构建期烘一份进 HTML，保证「JS 未执行 / 纯静态部署」时公告与维护提示也在；
    # 运行期 banner.js 会再用 settings_public() 校一次，站长改完不必等重建。
    # 拉不到就退回 site.config.json 里写死的那份（可能是空的）。
    if cloud:
        public_settings = fetch_public_settings(
            site_origin=site_origin, publishable_key=publishable_key
        )
        if public_settings:
            ann_from_cloud = announcement_of(public_settings)
            if ann_from_cloud.get("active"):
                # 云端启用时才覆盖；云端没开公告不该把本地写死的公告也抹掉
                config["announcement"] = ann_from_cloud
            mnt_from_cloud = maintenance_of(public_settings)
            if mnt_from_cloud.get("active") or (config.get("maintenance") or {}).get("active"):
                config["maintenance"] = mnt_from_cloud
            identity = site_identity_of(public_settings)
            if identity.get("title"):
                config["title"] = identity["title"]
            if identity.get("description"):
                config["description"] = identity["description"]
            config["identity"] = identity

    all_posts = sorted(
        [*posts, *cloud_posts],
        key=lambda post: (0 if post.get("pinned") else 1, -post["date"].timestamp()),
    )

    # --- 互动统计 + 最近评论（V2 / V6 / V15）---
    # 构建期从只读视图拉一次，把数字烘进静态 HTML：爬虫看得到、无 JS 也可用。
    # 拉取失败一律按 0 / 空处理，绝不让云端拖垮构建。
    post_stats: dict[str, dict] = {}
    recent_comments: list[dict] = []
    if cloud:
        post_stats = fetch_post_stats(
            site_origin=site_origin, publishable_key=publishable_key
        )
        recent_comments = fetch_recent_comments(
            site_origin=site_origin, publishable_key=publishable_key, limit=6
        )
    # 即使拿不到统计也要跑：给每篇补上 views/likes/bookmarks/comment_count/hot
    apply_stats(all_posts, post_stats)

    # --- 作者公开主页（authors/<owner_id>.html）---
    # 只给「有已发布文章的作者」建页：没有文章的空主页对访客没有意义，
    # 还会把所有注册用户都变成可枚举的公开页面。
    authors: list[dict] = []
    authors_by_id: dict[str, dict] = {}
    posts_by_author: dict[str, list] = {}
    for post in cloud_posts:
        author_id = str(post.get("author_id") or "")
        if author_id:
            posts_by_author.setdefault(author_id, []).append(post)
    for author_id, author_posts in posts_by_author.items():
        profile = public_profiles.get(author_id) or {}
        author = {
            "owner_id": author_id,
            "name": str(profile.get("nickname") or "").strip() or "匿名作者",
            "avatar_url": str(profile.get("avatar_url") or "").strip(),
            "bio": str(profile.get("bio") or "").strip(),
            "url": f"authors/{author_id}.html",
            "posts": sorted(author_posts, key=lambda p: -p["date"].timestamp()),
        }
        authors.append(author)
        authors_by_id[author_id] = author
    authors.sort(key=lambda a: (-len(a["posts"]), a["name"]))

    projects = load_projects(CONTENT_DIR, include_drafts)
    tags = collect_tags(all_posts)
    series = collect_series(all_posts)
    about_data = load_page(CONTENT_DIR, "about")

    options = config.get("options") or {}

    def option_int(key: str, fallback: int) -> int:
        try:
            return int(options.get(key, fallback))
        except (TypeError, ValueError):
            return fallback

    # 首页只放「最新 N 篇」，剩下的交给归档页 —— 否则文章一多首页会无限长。
    home_posts_count = option_int("homePosts", 8)
    home_posts = all_posts[:home_posts_count] if home_posts_count > 0 else all_posts

    # 首页「站点动态」：评论需要把云端 slug 映射回站内 URL；映射不到就丢弃
    # （评论所属文章可能已被删除或仍未发布）。
    posts_by_interact = {interact_key(post): post for post in all_posts}
    activity_comments = []
    for comment in recent_comments:
        target = posts_by_interact.get(comment["post_slug"])
        if not target or not str(target["url"]).startswith("posts/"):
            continue
        activity_comments.append({**comment, "url": target["url"]})
    # 「最近更新」按 updated 优先、否则用发布时间，取前 5
    activity_updated = sorted(
        all_posts,
        key=lambda post: -(post.get("updated") or post["date"]).timestamp(),
    )[:5]

    # 归档页分页（archive.html / archive-2.html …）
    archive_per_page = option_int("postsPerPage", 20)
    archive_pages, archive_total_pages = paginate(all_posts, archive_per_page)
    # 归档页在首页做客户端排序 / 增量展示时，需要的数据源（V2 / V3 / V15）。
    # items 的顺序就是服务端的默认顺序（置顶优先、再按时间倒序），
    # 所以客户端「最新排序」= 原样使用这份数组，不用再排一遍。
    archive_feed = {
        "pageSize": archive_per_page,
        "total": len(all_posts),
        "items": [
            {
                "title": post["title"],
                "url": post["url"],
                "date": post["date"].astimezone().strftime("%Y-%m-%d"),
                "year": str(post["date"].astimezone().year),
                "hot": int(post.get("hot") or 0),
                "views": int(post.get("views") or 0),
                "likes": int(post.get("likes") or 0),
                "comments": int(post.get("comment_count") or 0),
                "minutes": int(post.get("reading_time") or 0),
            }
            for post in all_posts
        ],
    }

    # --- 首页 ---
    write(
        "index.html",
        layout(
            config=config,
            title=config.get("title"),
            description=config.get("description"),
            root="",
            current="index.html",
            canonical="/",
            cloud=cloud,
            content=home_page(
                config=config,
                posts=home_posts,
                projects=projects,
                tags=tags,
                root="",
                total_posts=len(all_posts),
                activity={"comments": activity_comments, "updated": activity_updated},
                series=series,
            ),
        ),
    )

    # --- 项目列表 ---
    write(
        "projects.html",
        layout(
            config=config,
            title="项目",
            description=f"{config.get('author') or config.get('title')} 的项目作品集。",
            root="",
            current="projects.html",
            canonical="/projects.html",
            cloud=cloud,
            content=projects_page(config=config, projects=projects, root=""),
        ),
    )

    # --- 项目详情（depth 1）---
    if projects:
        os.makedirs(os.path.join(DIST_DIR, "projects"), exist_ok=True)
    for project in projects:
        write(
            project["url"],
            layout(
                config=config,
                title=project["title"],
                description=project["description"],
                root=root_prefix(1),
                current="projects.html",
                canonical=f"/{project['url']}",
                cloud=cloud,
                og_type="article",
                og_image=str(project.get("cover") or ""),
                scripts=_math_scripts(project),
                content=project_detail_page(config=config, project=project, root=root_prefix(1)),
            ),
        )

    # --- 关于页 ---
    write(
        "about.html",
        layout(
            config=config,
            title="关于",
            description=f"关于 {config.get('author') or config.get('title')}。",
            root="",
            current="about.html",
            canonical="/about.html",
            cloud=cloud,
            scripts=_math_scripts(about_data),
            content=about_page(config=config, page=about_data, root=""),
        ),
    )

    # --- 归档页（分页：archive.html / archive-2.html …）---
    for index, chunk in enumerate(archive_pages):
        page_no = index + 1
        rel_links = ""
        if page_no > 1:
            rel_links += f'<link rel="prev" href="{page_url("archive.html", page_no - 1)}">\n'
        if page_no < archive_total_pages:
            rel_links += f'<link rel="next" href="{page_url("archive.html", page_no + 1)}">\n'
        write(
            page_url("archive.html", page_no),
            layout(
                config=config,
                title=(
                    T("archive.title", lang)
                    if page_no == 1
                    else f'{T("archive.title", lang)} · {T("archive.page", lang, n=page_no)}'
                ),
                description=(
                    T("archive.summary", lang, total=len(all_posts))
                    if page_no == 1
                    else T(
                        "archive.summaryPaged",
                        lang,
                        total=len(all_posts),
                        page=page_no,
                        pages=archive_total_pages,
                    )
                ),
                root="",
                current="archive.html",
                canonical=f"/{page_url('archive.html', page_no)}",
                cloud=cloud,
                extra_head=rel_links.strip(),
                content=archive_page(
                    config=config,
                    posts=chunk,
                    root="",
                    page=page_no,
                    total_pages=archive_total_pages,
                    total=len(all_posts),
                    # 只有第一页带客户端数据源：排序 / 加载更多都在这一页发生
                    feed=archive_feed if page_no == 1 else None,
                    page_size=archive_per_page,
                ),
            ),
        )

    # --- 标签总览 ---
    write(
        "tags.html",
        layout(
            config=config,
            title=T("tags.title", lang),
            description=T("tags.summary", lang),
            root="",
            current="tags.html",
            canonical="/tags.html",
            cloud=cloud,
            breadcrumbs=[
                (T("common.home", lang), "index.html", "common.home"),
                (T("tags.title", lang), None, "tags.title"),
            ],
            content=tags_page(config=config, tags=tags, posts=all_posts, root=""),
        ),
    )

    # --- 单个标签（depth 2）---
    if tags:
        os.makedirs(os.path.join(DIST_DIR, "tags"), exist_ok=True)
    for tag in tags:
        tag_posts = [post for post in all_posts if any(slugify(t) == tag["slug"] for t in post["tags"])]
        write(
            f"tags/{tag['slug']}.html",
            layout(
                config=config,
                title=f"{T('tag.title', lang)}：{tag['name']}",
                description=T("tag.summary", lang, n=len(tag_posts)),
                root=root_prefix(2),
                current="tags.html",
                canonical=f"/tags/{tag['slug']}.html",
                cloud=cloud,
                breadcrumbs=[
                    (T("common.home", lang), "index.html", "common.home"),
                    (T("tags.title", lang), "tags.html", "tags.title"),
                    (tag["name"], None),
                ],
                content=tag_page(config=config, tag=tag, posts=tag_posts, root=root_prefix(2)),
            ),
        )

    # --- 系列（V7）：系列总览 + 每个系列一页 ---
    write(
        "series.html",
        layout(
            config=config,
            title=T("series.title", lang),
            description=T("series.summary", lang),
            root="",
            current="series.html",
            canonical="/series.html",
            cloud=cloud,
            breadcrumbs=[
                (T("common.home", lang), "index.html", "common.home"),
                (T("series.title", lang), None, "series.title"),
            ],
            content=series_index_page(config=config, series=series, root=""),
        ),
    )
    if series:
        os.makedirs(os.path.join(DIST_DIR, "series"), exist_ok=True)
    for item in series:
        write(
            f"series/{item['slug']}.html",
            layout(
                config=config,
                title=item["name"],
                description=T("series.summary", lang),
                root=root_prefix(2),
                current="series.html",
                canonical=f"/series/{item['slug']}.html",
                cloud=cloud,
                breadcrumbs=[
                    (T("common.home", lang), "index.html", "common.home"),
                    (T("series.title", lang), "series.html", "series.title"),
                    (item["name"], None),
                ],
                content=series_page(config=config, item=item, root=root_prefix(2)),
            ),
        )

    # --- 快捷键速查（V17）+ 订阅页（V11）---
    write(
        "shortcuts.html",
        layout(
            config=config,
            title=T("shortcuts.title", lang),
            description=T("shortcuts.lead", lang),
            root="",
            current="shortcuts.html",
            canonical="/shortcuts.html",
            cloud=cloud,
            breadcrumbs=[
                (T("common.home", lang), "index.html", "common.home"),
                (T("shortcuts.title", lang), None, "shortcuts.title"),
            ],
            content=shortcuts_page(config=config, root=""),
        ),
    )
    write(
        "subscribe.html",
        layout(
            config=config,
            title=T("subscribe.title", lang),
            description=T("subscribe.lead", lang),
            root="",
            current="subscribe.html",
            canonical="/subscribe.html",
            cloud=cloud,
            breadcrumbs=[
                (T("common.home", lang), "index.html", "common.home"),
                (T("subscribe.title", lang), None, "subscribe.title"),
            ],
            scripts=["subscribe.js"],
            content=subscribe_page(config=config, root="", cloud=cloud),
        ),
    )

    # --- 作者公开主页（depth 1）---
    if authors:
        os.makedirs(os.path.join(DIST_DIR, "authors"), exist_ok=True)
    for author in authors:
        author_url = str(config.get("url") or "").rstrip("/")
        author_json_ld = {
            "@context": "https://schema.org",
            "@type": "Person",
            "name": author["name"],
            "url": f"{author_url}/{author['url']}" if author_url else author["url"],
        }
        if author["bio"]:
            author_json_ld["description"] = author["bio"]
        if _is_http_url(author["avatar_url"]):
            author_json_ld["image"] = author["avatar_url"]
        author_head = (
            '<script type="application/ld+json">'
            + json.dumps(author_json_ld, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )
        write(
            author["url"],
            layout(
                config=config,
                title=f"{author['name']} 的文章",
                description=author["bio"] or f"{author['name']} 在{config.get('title') or '本站'}发布的 {len(author['posts'])} 篇文章。",
                root=root_prefix(1),
                current="",
                canonical=f"/{author['url']}",
                extra_head=author_head,
                cloud=cloud,
                og_type="profile",
                og_image=author["avatar_url"] if _is_http_url(author["avatar_url"]) else "",
                content=author_page(config=config, author=author, posts=author["posts"], root=root_prefix(1)),
            ),
        )

    # --- 文章详情（depth 1）：静态文章与云端文章都落静态页 ---
    article_posts = all_posts
    if article_posts:
        os.makedirs(os.path.join(DIST_DIR, "posts"), exist_ok=True)
    for index, post in enumerate(article_posts):
        # 云文章若因 slug 冲突退回 post.html?slug=（客户端渲染），这里跳过落盘
        if not str(post["url"]).startswith("posts/"):
            continue
        # all_posts 已按置顶 + 时间倒序，上一篇 = 更新的那篇
        prev_post = article_posts[index - 1] if index > 0 else None
        next_post = article_posts[index + 1] if index + 1 < len(article_posts) else None

        # 相关文章：标签重合度优先；没有重合时按时间就近兜底
        scored = []
        for other in article_posts:
            if other is post:
                continue
            overlap = len(set(post["tags"]) & set(other["tags"]))
            scored.append((overlap, other))
        if any(overlap > 0 for overlap, _ in scored):
            ranked = sorted(scored, key=lambda pair: (-pair[0], -pair[1]["date"].timestamp()))
        else:
            ranked = sorted(scored, key=lambda pair: -pair[1]["date"].timestamp())
        related = [other for _, other in ranked[:3]]

        article_meta = "\n".join(
            [f'<meta property="article:tag" content="{esc(tag)}">' for tag in post["tags"]]
        )
        post_author = _author_for_post(post, authors_by_id)
        site_url = str(config.get("url") or "").rstrip("/")
        json_ld = {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            "headline": post["title"],
            "datePublished": iso_date(post["date"]),
            "author": {"@type": "Person", "name": (post_author or {}).get("name") or str(config.get("author") or "")},
            "description": post["summary"],
            "mainEntityOfPage": f"{site_url}/{post['url']}" if site_url else post["url"],
        }
        if post.get("cover"):
            json_ld["image"] = post["cover"]
        extra_head = (
            f'<meta property="article:published_time" content="{iso_date(post["date"])}">\n'
            + f"{article_meta}\n"
            + '<script type="application/ld+json">'
            + json.dumps(json_ld, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

        write(
            post["url"],
            layout(
                config=config,
                title=post["title"],
                description=post["summary"],
                root=root_prefix(1),
                current="",
                canonical=f"/{post['url']}",
                show_progress=True,
                extra_head=extra_head,
                cloud=cloud,
                scripts=[*_math_scripts(post), "interact.js"],
                og_type="article",
                og_image=str(post.get("cover") or ""),
                content=post_page(
                    config=config, post=post, prev_post=prev_post, next_post=next_post,
                    related=related, root=root_prefix(1),
                    interact_slug=post.get("interact_slug") or post["slug"],
                    author=post_author,
                ),
            ),
        )

    # --- 账号与后台（仅接入云能力时才有意义）---
    if cloud:
        write(
            "login.html",
            layout(
                config=config,
                title="登录 / 注册",
                description="一个入口登录：普通账号注册即可评论、点赞、收藏；管理员账号登录后可自选进入后台。",
                root="",
                current="",
                cloud=True,
                scripts=["auth.js"],
                content=login_page(config=config, root=""),
            ),
        )
        write(
            "account.html",
            layout(
                config=config,
                title="个人中心",
                description="维护个人资料，查看我的评论与收藏。",
                root="",
                current="",
                cloud=True,
                scripts=["upload.js", "avatar-crop.js", "account.js"],
                content=account_page(config=config, root=""),
            ),
        )
        write(
            "write.html",
            layout(
                config=config,
                title="写文章",
                description="用 Markdown 撰写技术分享，保存草稿或提交给站长审核。",
                root="",
                current="",
                cloud=True,
                vendor=["marked", "highlight"],
                scripts=[
                    "math.js", "cloud-markdown.js", "upload.js",
                    "draft.js", "write.js", "write-ext.js",
                ],
                content=write_page(config=config, root=""),
            ),
        )
        write(
            "admin.html",
            layout(
                config=config,
                title="管理后台",
                description="在线撰写与发布文章、管理评论与用户。",
                root="",
                current="",
                cloud=True,
                vendor=["marked", "highlight"],
                scripts=[
                    "math.js", "cloud-markdown.js", "upload.js",
                    "draft.js", "chart.js", "write-ext.js", "admin.js", "admin-ext.js",
                ],
                content=admin_page(config=config, root=""),
            ),
        )
        # A4 预览分享页：纯客户端按 token 渲染，不预生成任何内容
        write(
            "preview.html",
            layout(
                config=config,
                title="预览",
                description="查看一条尚未发布的稿件快照。",
                root="",
                current="",
                cloud=True,
                extra_head=PREVIEW_NOINDEX,
                vendor=["marked", "highlight"],
                scripts=["math.js", "cloud-markdown.js", "preview.js"],
                content=preview_page(config=config, root=""),
            ),
        )
        write(
            "notifications.html",
            layout(
                config=config,
                title="通知中心",
                description="有人回复你、评论你的文章，或投稿有了审核结果时的站内提醒。",
                root="",
                current="",
                cloud=True,
                scripts=["notifications.js"],
                content=notifications_page(config=config, root=""),
            ),
        )
        write(
            "posts.html",
            layout(
                config=config,
                title="在线文章",
                description="管理员在线发布的文章，支持点赞、收藏与评论。",
                root="",
                current="posts.html",
                canonical="/posts.html",
                cloud=True,
                scripts=["cloud-posts.js"],
                content=cloud_posts_page(config=config, root=""),
            ),
        )
        write(
            "post.html",
            layout(
                config=config,
                title="在线文章",
                description="在线阅读管理员发布的文章。",
                root="",
                current="posts.html",
                cloud=True,
                vendor=["marked", "highlight"],
                scripts=["math.js", "cloud-markdown.js", "cloud-posts.js", "interact.js"],
                content=cloud_post_page(config=config, root=""),
            ),
        )

    # --- 404 ---
    write(
        "404.html",
        layout(
            config=config,
            title="页面不存在",
            root="",
            current="",
            cloud=cloud,
            content=not_found_page(config=config, root="", posts=all_posts, tags=tags),
        ),
    )

    # --- 静态资源 ---
    copy_file(os.path.join(SRC_DIR, "styles", "main.css"), os.path.join("assets", "main.css"))
    for name in ASSET_SCRIPTS:
        source = os.path.join(SRC_DIR, "scripts", name)
        if os.path.isfile(source):
            copy_file(source, os.path.join("assets", name))

    # --- 界面文案词典 + 切换逻辑（由 wsblog/i18n.py 生成）---
    # 生成而不是手写：词典与 Python 侧的 T() 共用同一份 MESSAGES，
    # 构建期的静态文案和客户端的动态文案永远不会对不上。
    write("assets/i18n.js", build_i18n_js(normalize_lang(config.get("lang"))))

    # --- 本地字体等自有资源（src/assets/** → dist/assets/**）---
    # 字体改为本地化后不再依赖 Google Fonts，必须随构建一起进产物
    assets_src = os.path.join(SRC_DIR, "assets")
    if os.path.isdir(assets_src):
        for root, _dirs, files in os.walk(assets_src):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, assets_src)
                copy_file(full, os.path.join("assets", rel))

    # --- 云端配置（前端读 window.__CLOUD__）---
    if cloud:
        write("assets/cloud-config.js", build_cloud_config_js(config, site_origin=site_origin))

        # 静态文章 slug 清单：管理员打开后台时静默同步到云端 known_slugs，
        # 作为浏览量接口的白名单（防匿名灌随机 slug 撑表）
        write(
            "assets/slug-manifest.json",
            json.dumps(
                {
                    "generatedAt": datetime.now().isoformat(timespec="seconds"),
                    "slugs": [post["slug"] for post in posts],
                },
                ensure_ascii=False,
                indent=2,
            ),
        )

    # --- 第三方库本地化（src/vendor/ → dist/assets/vendor/）---
    # 不依赖外部 CDN：marked / highlight / KaTeX / Mermaid 全部随站点打包。
    # 注意这一层不在 cloud 分支里 —— KaTeX 与 Mermaid 和云能力毫无关系，
    # 纯静态站点也要能用（之前放在 cloud 分支里是个隐患）。
    vendor_src = os.path.join(SRC_DIR, "vendor")
    if os.path.isdir(vendor_src):
        for walk_root, _dirs, files in os.walk(vendor_src):
            for name in files:
                full = os.path.join(walk_root, name)
                rel = os.path.relpath(full, vendor_src)
                copy_file(full, os.path.join("assets", "vendor", rel))

    # 供 assets/math.js 按需拉取：地址仍以 cloud.config.json 的 vendor 映射为唯一来源，
    # 避免路径散落在 JS 里。这个文件在任何部署形态下都存在。
    write(
        "assets/vendor-map.js",
        "/* 本文件由 build.py 自动生成，请勿手改；改 cloud.config.json 后重新构建。 */\n"
        "window.__VENDOR__ = "
        + json.dumps(
            {
                key: vendor_url(key)
                for key in ("marked", "highlight", "katex", "katexCss", "mermaid", "sdk")
            },
            ensure_ascii=False,
            indent=2,
        )
        + ";\n",
    )

    # --- 搜索索引（V16：元数据与正文分离）---
    # 以前是一个文件带正文一起下发，体积随文章数线性膨胀（每篇 1600 字的正文）。
    # 现在拆成两层：
    #   search-index.json        只含标题 / 摘要 / 标签 / 日期 —— 体积稳定，打开搜索就拉
    #   search-index/text-N.json 每片若干条的正文 —— 只在真的需要全文检索时才逐片拉
    # 前端的顺序是「先出元数据命中，再后台补全文命中」，首屏结果不再等大文件。
    search_meta = [
        {
            "kind": "post" if post["type"] == "post" else "cloud_post",
            "title": post["title"],
            "url": post["url"],
            "summary": post["summary"],
            "tags": post["tags"],
            "date": iso_date(post["date"])[:10],
        }
        for post in all_posts
    ]
    search_meta += [
        {
            "kind": "project",
            "title": project["title"],
            "url": project["url"],
            "summary": project["description"],
            "tags": [*project["tags"], *project["stack"]],
            "date": iso_date(project["date"])[:10],
        }
        for project in projects
    ]
    search_meta += [
        {
            "kind": "tag",
            "title": f"标签：{tag['name']}",
            "url": f"tags/{tag['slug']}.html",
            "summary": f"{tag['count']} 篇文章",
            "tags": [tag["name"]],
            "date": "",
        }
        for tag in tags
    ]

    # 正文分片：只给真有可能被全文检索搜到的内容（文章与项目），标签不需要
    body_rows = [
        {"url": post["url"], "text": truncate(post["plain"], 1600)}
        for post in all_posts
    ] + [
        {"url": project["url"], "text": truncate(project["plain"], 900)}
        for project in projects
    ]
    body_rows = [row for row in body_rows if row["text"]]
    text_shard_size = 16
    shards = [body_rows[i:i + text_shard_size] for i in range(0, len(body_rows), text_shard_size)]
    for index, shard in enumerate(shards, start=1):
        write(
            f"search-index/text-{index}.json",
            json.dumps(shard, ensure_ascii=False, separators=(",", ":")),
        )

    write(
        "search-index.json",
        json.dumps(
            {
                "generatedAt": iso_date(datetime.now().astimezone()),
                "count": len(search_meta),
                # 前端据此拼 search-index/text-<n>.json；0 表示没有正文分片
                "textShards": len(shards),
                "textShardSize": text_shard_size,
                "items": search_meta,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )

    # --- RSS / sitemap / robots ---
    write("feed.xml", build_feed(config, all_posts))
    write("sitemap.xml", build_sitemap(config, posts=all_posts, projects=projects, tags=tags, archive_pages=archive_total_pages, authors=authors))
    robots = "User-agent: *\nAllow: /\n"
    if config.get("url"):
        robots += f"Sitemap: {str(config['url']).rstrip('/')}/sitemap.xml\n"
    write("robots.txt", robots)

    # --- GitHub Pages 用，避免下划线目录被 Jekyll 忽略 ---
    write(".nojekyll", "")

    # --- PWA：manifest / Service Worker / 离线页 ---
    write("site.webmanifest", build_manifest(config))
    sw_source = os.path.join(SRC_DIR, "sw.js")
    if os.path.isfile(sw_source):
        copy_file(sw_source, "sw.js")
    write(
        "offline.html",
        layout(
            config=config,
            title="离线",
            description="当前没有网络连接。",
            root="",
            current="",
            cloud=cloud,
            content=offline_page(config=config, root=""),
        ),
    )

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    # --- 构建信息（B14 健康检查面板读它，用来回答「线上是哪次构建」）---
    write(
        "assets/build-info.json",
        json.dumps(
            {
                "generatedAt": iso_date(datetime.now().astimezone()),
                "generatedTs": int(datetime.now().timestamp()),
                "elapsedMs": elapsed_ms,
                "cloud": cloud,
                "origin": site_origin,
                "posts": {"total": len(all_posts), "static": len(posts), "cloud": len(cloud_posts)},
                "projects": len(projects),
                "tags": len(tags),
                "authors": len(authors),
                "announcement": bool((config.get("announcement") or {}).get("active")),
                "maintenance": bool((config.get("maintenance") or {}).get("active")),
                "generator": "ws-blog",
            },
            ensure_ascii=False,
            indent=2,
        ),
    )

    # 核心页（首页 / 项目 / 关于 / 标签 / 404）+ 归档各页 + 文章 / 项目 / 标签 / 作者详情 + 云端页面
    page_count = (
        5
        + archive_total_pages
        + len(all_posts)
        + len(projects)
        + len(tags)
        + len(authors)
        + (7 if cloud else 0)
    )
    drafts_note = "已包含" if any(post["draft"] for post in posts) else "未包含"

    print(f"· 文章 {len(all_posts)} 篇（静态 {len(posts)} + 云端 {len(cloud_posts)}，含草稿 {drafts_note}）")
    print(f"· 首页展示 {len(home_posts)} 篇 / 归档每页 {archive_per_page or '不限'} 篇（共 {archive_total_pages} 页）")
    print(f"· 项目 {len(projects)} 个")
    print(f"· 标签 {len(tags)} 个")
    if authors:
        print(f"· 作者主页 {len(authors)} 个（有已发布文章的作者）")
    print(f"· 页面 {page_count} 个")
    print(f"· 云能力 {'已接入（登录 / 评论 / 后台）' if cloud else '未接入（纯静态）'}")
    print(f"✓ 构建完成，用时 {elapsed_ms}ms → {os.path.relpath(DIST_DIR, os.getcwd())}")

    return {
        "posts": len(posts),
        "projects": len(projects),
        "tags": len(tags),
        "pages": page_count,
        "cloud": cloud,
        "elapsed_ms": elapsed_ms,
        "nested_anchors": list(nested_anchor_issues),
    }


# ---------------- PWA ----------------

def build_manifest(config: dict) -> str:
    site = str(config.get("title") or "Blog")
    manifest = {
        "name": site,
        "short_name": site[:12],
        "description": str(config.get("description") or ""),
        "lang": str(config.get("lang") or "zh-CN"),
        # 相对路径：无论部署在域名根还是子路径（GitHub Pages），都以 manifest 所在目录为基准
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "theme_color": "#0a0c11",
        "background_color": "#0a0c11",
        "icons": [
            {"src": "assets/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "assets/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {
                "src": "assets/icon-maskable-512.png",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "maskable",
            },
        ],
    }
    return json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"


# ---------------- RSS ----------------

def build_feed(config: dict, posts: list) -> str:
    site = str(config.get("url") or "https://example.com").rstrip("/")

    entries = []
    for post in posts[:20]:
        tag_lines = "\n".join(f"      <category>{esc(tag)}</category>" for tag in post["tags"])
        entries.append(
            "    <item>\n"
            f"      <title>{esc(post['title'])}</title>\n"
            f"      <link>{site}/{post['url']}</link>\n"
            f'      <guid isPermaLink="true">{site}/{post["url"]}</guid>\n'
            f"      <pubDate>{utc_string(post['date'])}</pubDate>\n"
            f"      <description>{esc(post['summary'])}</description>\n"
            f"{tag_lines}\n"
            "    </item>"
        )
    items = "\n".join(entries)

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n'
        "  <channel>\n"
        f"    <title>{esc(config.get('title'))}</title>\n"
        f"    <link>{site}</link>\n"
        f"    <description>{esc(config.get('description') or '')}</description>\n"
        f"    <language>{esc(config.get('lang') or 'zh-CN')}</language>\n"
        f"    <lastBuildDate>{utc_string(datetime.now().astimezone())}</lastBuildDate>\n"
        f'    <atom:link href="{site}/feed.xml" rel="self" type="application/rss+xml"/>\n'
        f"{items}\n"
        "  </channel>\n"
        "</rss>\n"
    )


# ---------------- sitemap ----------------

def build_sitemap(config: dict, *, posts: list, projects: list, tags: list, archive_pages: int = 1, authors: list | None = None) -> str:
    site = str(config.get("url") or "https://example.com").rstrip("/")
    urls = [
        {"loc": "/", "priority": "1.0"},
        {"loc": "/projects.html", "priority": "0.8"},
        {"loc": "/archive.html", "priority": "0.6"},
        {"loc": "/tags.html", "priority": "0.6"},
        {"loc": "/about.html", "priority": "0.6"},
    ]
    urls += [
        {"loc": f"/{page_url('archive.html', n)}", "priority": "0.4"}
        for n in range(2, max(1, archive_pages) + 1)
    ]
    urls += [
        {"loc": f"/{post['url']}", "lastmod": iso_date(post["date"])[:10], "priority": "0.9"}
        for post in posts
    ]
    urls += [{"loc": f"/{project['url']}", "priority": "0.7"} for project in projects]
    urls += [{"loc": f"/tags/{tag['slug']}.html", "priority": "0.5"} for tag in tags]
    urls += [{"loc": f"/{author['url']}", "priority": "0.5"} for author in (authors or [])]

    body = "\n".join(
        "  <url><loc>{site}{loc}</loc>{lastmod}<priority>{priority}</priority></url>".format(
            site=site,
            loc=item["loc"],
            lastmod=f"<lastmod>{item['lastmod']}</lastmod>" if item.get("lastmod") else "",
            priority=item["priority"],
        )
        for item in urls
    )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{body}\n"
        "</urlset>\n"
    )


# ---------------- 新建内容脚手架 ----------------

def scaffold(content_type: str, title: str) -> int:
    if content_type not in ("post", "project"):
        print('用法：python build.py --new post "文章标题"')
        print('      python build.py --new project "项目名称"')
        return 1
    if not title:
        print('请提供标题，例如：python build.py --new post "我的第一篇博客"')
        return 1

    slug = slugify(title)
    folder = "posts" if content_type == "post" else "projects"
    directory = os.path.join(CONTENT_DIR, folder)
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, f"{slug}.md")

    if os.path.exists(target):
        print(f"文件已存在：{os.path.relpath(target, os.getcwd())}")
        return 1

    today = datetime.now().astimezone().isoformat()[:10]

    if content_type == "post":
        body = f"""---
title: {title}
date: {today}
tags: [待填写]
summary: 一句话说明这篇文章解决了什么问题。
pinned: false
draft: true
---

## 背景

为什么写这篇？遇到了什么问题？

## 具体做法

```js
console.log('hello');
```

> [!TIP]
> 提示块的写法：> [!TIP] / [!NOTE] / [!WARNING] / [!CAUTION]

## 小结

- 要点一
- 要点二
"""
    else:
        body = f"""---
title: {title}
description: 一句话说明这个项目是什么、解决了什么问题。
date: {today}
stack: [TypeScript, React]
status: 活跃
featured: false
order: 100
repo: ""
demo: ""
draft: true
---

## 项目简介

它是什么，面向谁。

## 技术选型

| 层次 | 选型 | 理由 |
| --- | --- | --- |
| 前端 | React | 生态成熟 |

## 难点与取舍

记录真正有价值的部分：为什么这样做，而不是那样做。
"""

    with open(target, "w", encoding="utf-8", newline="") as handle:
        handle.write(body)

    print(f"✓ 已创建 {os.path.relpath(target, os.getcwd())}")
    print("  （draft: true，改完记得改成 false 或删掉这一行）")
    return 0


# ---------------- 入口 ----------------

def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="build.py",
        description="WS Blog 静态站点生成器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            '  python build.py --new post "我的第一篇博客"\n'
            "  python build.py --serve --port 4173\n"
        ),
    )
    parser.add_argument("--new", nargs="*", metavar=("TYPE", "TITLE"),
                        help='新建内容：--new post "标题" / --new project "名称"')
    parser.add_argument("--serve", action="store_true", help="启动本地预览服务器（含自动重建）")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"),
                        help="预览服务器绑定地址（默认 127.0.0.1，云端部署用 0.0.0.0）")
    parser.add_argument("--drafts", action="store_true", help="连草稿一起生成")
    parser.add_argument("--clean", action="store_true", help="先清空 dist/ 再生成")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 4173)), help="预览端口（默认 4173）")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    if args.new is not None:
        parts = list(args.new)
        return scaffold(parts[0] if parts else "", parts[1] if len(parts) > 1 else "")

    include_drafts = args.drafts or args.serve

    # 首次运行时，如果 content/ 不存在就建好骨架，避免报错
    for name in ("posts", "projects", "pages"):
        os.makedirs(os.path.join(CONTENT_DIR, name), exist_ok=True)

    try:
        build(include_drafts=include_drafts, clean=args.clean)
    except Exception as exc:  # noqa: BLE001
        print(f"✗ 构建失败：{exc}")
        traceback.print_exc()
        return 1

    if args.serve:
        # 云端内容变化 → 自动重建（发布即生效）：进程自己轮询云端指纹，
        # 不需要部署密钥或 webhook；与本地文件监听共用一把构建锁。
        cloud_check = None
        if cloud_enabled():
            serve_config = read_config()
            serve_origin = str(
                serve_config.get("siteOrigin") or serve_config.get("url") or ""
            ).rstrip("/")
            serve_key = str(load_cloud_config().get("publishableKey") or "")

            def cloud_check():
                return cloud_posts_fingerprint(site_origin=serve_origin, publishable_key=serve_key)

        build_lock = threading.Lock()

        def rebuild():
            with build_lock:
                build(include_drafts=True, clean=False)

        serve(
            DIST_DIR,
            port=args.port,
            host=args.host,
            rebuild=rebuild,
            watch_dirs=[CONTENT_DIR, SRC_DIR],
            cloud_check=cloud_check,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
