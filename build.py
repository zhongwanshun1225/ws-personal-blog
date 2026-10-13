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
)
from wsblog.cloudposts import fetch_published_cloud_posts  # noqa: E402
from wsblog.content import collect_tags, load_page, load_posts, load_projects  # noqa: E402
from wsblog.server import serve  # noqa: E402
from wsblog.templates.layout import layout  # noqa: E402
from wsblog.templates.pages import (  # noqa: E402
    about_page,
    account_page,
    admin_page,
    archive_page,
    cloud_post_page,
    cloud_posts_page,
    home_page,
    login_page,
    not_found_page,
    post_page,
    project_detail_page,
    projects_page,
    related_posts_block,
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

# 需要拷贝到 dist/assets/ 的浏览器端脚本
ASSET_SCRIPTS = (
    "theme.js",
    "app.js",
    "cloud.js",
    "cloud-markdown.js",
    "auth.js",
    "interact.js",
    "account.js",
    "write.js",
    "admin.js",
    "cloud-posts.js",
    "upload.js",
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

def build(include_drafts: bool = False, clean: bool = False) -> dict:
    started = time.perf_counter()
    config = read_config()
    nested_anchor_issues.clear()

    cloud = cloud_enabled()
    site_origin = str(config.get("siteOrigin") or "").rstrip("/")
    if cloud and not site_origin:
        # 云服务按 Origin 校验请求，这里兜底用站点 url，正式部署时应显式配置
        site_origin = str(config.get("url") or "").rstrip("/")

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
    if cloud:
        cloud_posts = fetch_published_cloud_posts(
            site_origin=site_origin,
            publishable_key=str(load_cloud_config().get("publishableKey") or ""),
        )
    all_posts = sorted(
        [*posts, *cloud_posts],
        key=lambda post: (0 if post.get("pinned") else 1, -post["date"].timestamp()),
    )

    projects = load_projects(CONTENT_DIR, include_drafts)
    tags = collect_tags(all_posts)
    about_data = load_page(CONTENT_DIR, "about")

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
            content=home_page(config=config, posts=all_posts, projects=projects, tags=tags, root=""),
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
            content=about_page(config=config, page=about_data, root=""),
        ),
    )

    # --- 归档页 ---
    write(
        "archive.html",
        layout(
            config=config,
            title="归档",
            description="全部文章按发布时间归档。",
            root="",
            current="archive.html",
            canonical="/archive.html",
            cloud=cloud,
            content=archive_page(config=config, posts=all_posts, root=""),
        ),
    )

    # --- 标签总览 ---
    write(
        "tags.html",
        layout(
            config=config,
            title="标签",
            description="按标签浏览全部文章。",
            root="",
            current="tags.html",
            canonical="/tags.html",
            cloud=cloud,
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
                title=f"标签：{tag['name']}",
                description=f"标签「{tag['name']}」下的全部文章。",
                root=root_prefix(2),
                current="tags.html",
                canonical=f"/tags/{tag['slug']}.html",
                cloud=cloud,
                content=tag_page(config=config, tag=tag, posts=tag_posts, root=root_prefix(2)),
            ),
        )

    # --- 文章详情（depth 1）---
    if posts:
        os.makedirs(os.path.join(DIST_DIR, "posts"), exist_ok=True)
    for index, post in enumerate(posts):
        # posts 已按置顶 + 时间倒序，上一篇 = 更新的那篇
        prev_post = posts[index - 1] if index > 0 else None
        next_post = posts[index + 1] if index + 1 < len(posts) else None

        # 相关文章：标签重合度优先；没有重合时按时间就近兜底
        scored = []
        for other in posts:
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
        site_url = str(config.get("url") or "").rstrip("/")
        json_ld = {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            "headline": post["title"],
            "datePublished": iso_date(post["date"]),
            "author": {"@type": "Person", "name": str(config.get("author") or "")},
            "description": post["summary"],
            "mainEntityOfPage": f"{site_url}/{post['url']}" if site_url else post["url"],
        }
        if post.get("cover"):
            json_ld["image"] = post["cover"]
        extra_head = (
            '<meta property="og:type" content="article">\n'
            f'<meta property="article:published_time" content="{iso_date(post["date"])}">\n'
            + (
                f'<meta property="og:image" content="{esc(post["cover"])}">\n'
                if post.get("cover")
                else ""
            )
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
                scripts=["interact.js"],
                content=post_page(
                    config=config, post=post, prev_post=prev_post, next_post=next_post,
                    related=related, root=root_prefix(1)
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
                scripts=["upload.js", "account.js"],
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
                scripts=["cloud-markdown.js", "upload.js", "write.js"],
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
                scripts=["cloud-markdown.js", "upload.js", "admin.js"],
                content=admin_page(config=config, root=""),
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
                scripts=["cloud-markdown.js", "cloud-posts.js"],
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
            content=not_found_page(root=""),
        ),
    )

    # --- 静态资源 ---
    copy_file(os.path.join(SRC_DIR, "styles", "main.css"), os.path.join("assets", "main.css"))
    for name in ASSET_SCRIPTS:
        source = os.path.join(SRC_DIR, "scripts", name)
        if os.path.isfile(source):
            copy_file(source, os.path.join("assets", name))

    # --- 云端配置（前端读 window.__CLOUD__）---
    if cloud:
        write("assets/cloud-config.js", build_cloud_config_js(config, site_origin=site_origin))
        # 第三方库本地化（src/vendor/ → dist/assets/vendor/），不依赖外部 CDN
        vendor_src = os.path.join(SRC_DIR, "vendor")
        if os.path.isdir(vendor_src):
            for name in sorted(os.listdir(vendor_src)):
                source = os.path.join(vendor_src, name)
                if name.endswith(".js") and os.path.isfile(source):
                    copy_file(source, os.path.join("assets", "vendor", name))

    # --- 搜索索引 ---
    search_items = [
        {
            "kind": "post" if post["type"] == "post" else "cloud_post",
            "title": post["title"],
            "url": post["url"],
            "summary": post["summary"],
            "tags": post["tags"],
            "date": iso_date(post["date"])[:10],
            "text": truncate(post["plain"], 1600),
        }
        for post in all_posts
    ]
    search_items += [
        {
            "kind": "project",
            "title": project["title"],
            "url": project["url"],
            "summary": project["description"],
            "tags": [*project["tags"], *project["stack"]],
            "date": iso_date(project["date"])[:10],
            "text": truncate(project["plain"], 900),
        }
        for project in projects
    ]
    search_items += [
        {
            "kind": "tag",
            "title": f"标签：{tag['name']}",
            "url": f"tags/{tag['slug']}.html",
            "summary": f"{tag['count']} 篇文章",
            "tags": [tag["name"]],
            "date": "",
            "text": "",
        }
        for tag in tags
    ]
    write(
        "search-index.json",
        json.dumps(
            {
                "generatedAt": iso_date(datetime.now().astimezone()),
                "count": len(search_items),
                "items": search_items,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )

    # --- RSS / sitemap / robots ---
    write("feed.xml", build_feed(config, all_posts))
    write("sitemap.xml", build_sitemap(config, posts=all_posts, projects=projects, tags=tags))
    robots = "User-agent: *\nAllow: /\n"
    if config.get("url"):
        robots += f"Sitemap: {str(config['url']).rstrip('/')}/sitemap.xml\n"
    write("robots.txt", robots)

    # --- GitHub Pages 用，避免下划线目录被 Jekyll 忽略 ---
    write(".nojekyll", "")

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    page_count = 5 + len(posts) + len(projects) + len(tags) + (5 if cloud else 0)
    drafts_note = "已包含" if any(post["draft"] for post in posts) else "未包含"

    print(f"· 文章 {len(posts)} 篇（含草稿 {drafts_note}）")
    print(f"· 项目 {len(projects)} 个")
    print(f"· 标签 {len(tags)} 个")
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

def build_sitemap(config: dict, *, posts: list, projects: list, tags: list) -> str:
    site = str(config.get("url") or "https://example.com").rstrip("/")
    urls = [
        {"loc": "/", "priority": "1.0"},
        {"loc": "/projects.html", "priority": "0.8"},
        {"loc": "/archive.html", "priority": "0.6"},
        {"loc": "/tags.html", "priority": "0.6"},
        {"loc": "/about.html", "priority": "0.6"},
    ]
    urls += [
        {"loc": f"/{post['url']}", "lastmod": iso_date(post["date"])[:10], "priority": "0.9"}
        for post in posts
    ]
    urls += [{"loc": f"/{project['url']}", "priority": "0.7"} for project in projects]
    urls += [{"loc": f"/tags/{tag['slug']}.html", "priority": "0.5"} for tag in tags]

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
repo: https://github.com/your-github/{slug}
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
        serve(
            DIST_DIR,
            port=args.port,
            host=args.host,
            rebuild=lambda: build(include_drafts=True, clean=False),
            watch_dirs=[CONTENT_DIR, SRC_DIR],
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
