"""内容加载层：把 content/ 目录下的 Markdown 文件读成结构化数据。"""

from __future__ import annotations

import os
import re
from datetime import datetime

from .frontmatter import parse_frontmatter
from .markdown import render_markdown
from .util import html_to_plain_text, parse_date, reading_time, slugify, truncate

__all__ = ["load_posts", "load_projects", "load_page", "collect_tags"]

_TAG_SPLIT_RE = re.compile(r"[,，、]")


def _list_markdown_files(directory: str) -> list[str]:
    """列出某个目录下的所有 .md 文件（按文件名排序，保证构建结果可复现）。"""
    if not os.path.isdir(directory):
        return []
    names = sorted(os.listdir(directory))
    files = []
    for name in names:
        full = os.path.join(directory, name)
        if os.path.isfile(full) and name.lower().endswith(".md"):
            files.append(full)
    return files


def _read_source(file_path: str):
    with open(file_path, "r", encoding="utf-8") as handle:
        raw = handle.read()
    data, body = parse_frontmatter(raw)
    stat = os.stat(file_path)
    fallback_title = os.path.splitext(os.path.basename(file_path))[0]
    return data, body, stat, fallback_title


def _normalize_tags(value) -> list[str]:
    """统一把 tags 规整为字符串数组。"""
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [part.strip() for part in _TAG_SPLIT_RE.split(value) if part.strip()]
    return []


def _normalize_date(value, stat) -> datetime:
    parsed = parse_date(value)
    if parsed is not None:
        return parsed
    return datetime.fromtimestamp(stat.st_mtime).astimezone()


def load_posts(content_dir: str, include_drafts: bool = False) -> list[dict]:
    """加载文章。目录里以 ``_`` 开头的文件会被视为草稿。"""
    posts = []
    for file_path in _list_markdown_files(os.path.join(content_dir, "posts")):
        data, body, stat, fallback_title = _read_source(file_path)
        rendered = render_markdown(body)
        html = rendered["html"]
        plain = html_to_plain_text(html)

        base_name = os.path.basename(file_path)
        is_draft = data.get("draft") is True or base_name.startswith("_")
        slug_source = data.get("slug") or os.path.splitext(base_name)[0]
        slug = slugify(str(slug_source))

        posts.append(
            {
                "type": "post",
                "title": str(data["title"]) if data.get("title") else fallback_title,
                "slug": slug,
                "url": f"posts/{slug}.html",
                "date": _normalize_date(data.get("date"), stat),
                "updated": _normalize_date(data["updated"], stat) if data.get("updated") else None,
                "tags": _normalize_tags(data.get("tags")),
                "summary": str(data["summary"]) if data.get("summary") else truncate(plain, 110),
                "cover": str(data["cover"]) if data.get("cover") else "",
                "draft": is_draft,
                "pinned": data.get("pinned") is True,
                "html": html,
                "toc": rendered["toc"],
                "plain": plain,
                "reading_time": reading_time(plain),
                "words": len(plain),
                "source_path": file_path,
            }
        )
    return posts


def load_projects(content_dir: str, include_drafts: bool = False) -> list[dict]:
    """加载项目卡片，精选优先、order 次之、日期最后。"""
    projects = []
    for file_path in _list_markdown_files(os.path.join(content_dir, "projects")):
        data, body, stat, fallback_title = _read_source(file_path)
        rendered = render_markdown(body)
        plain = html_to_plain_text(rendered["html"])
        base_name = os.path.basename(file_path)

        links = []
        if data.get("repo"):
            links.append({"label": "源码", "url": str(data["repo"]), "kind": "repo"})
        if data.get("demo"):
            links.append({"label": "在线演示", "url": str(data["demo"]), "kind": "demo"})
        if data.get("docs"):
            links.append({"label": "文档", "url": str(data["docs"]), "kind": "docs"})
        for entry in _normalize_tags(data.get("links")):
            parts = [part.strip() for part in str(entry).split("|")]
            if len(parts) >= 2 and parts[0] and parts[1]:
                links.append({"label": parts[0], "url": parts[1], "kind": "link"})

        slug_source = data.get("slug") or os.path.splitext(base_name)[0]
        slug = slugify(str(slug_source))
        order = data.get("order")
        projects.append(
            {
                "type": "project",
                "title": str(data["title"]) if data.get("title") else fallback_title,
                "slug": slug,
                "url": f"projects/{slug}.html",
                "description": str(data["description"]) if data.get("description") else truncate(plain, 120),
                "date": _normalize_date(data.get("date"), stat),
                "tags": _normalize_tags(data.get("tags")),
                "stack": _normalize_tags(data.get("stack")),
                "status": str(data["status"]) if data.get("status") else "",
                "featured": data.get("featured") is True,
                "order": order if isinstance(order, (int, float)) and not isinstance(order, bool) else 999,
                "cover": str(data["cover"]) if data.get("cover") else "",
                "accent": str(data["accent"]) if data.get("accent") else "",
                "links": links,
                "draft": data.get("draft") is True or base_name.startswith("_"),
                "html": rendered["html"],
                "plain": plain,
                "source_path": file_path,
            }
        )

    visible = [item for item in projects if include_drafts or not item["draft"]]
    visible.sort(
        key=lambda item: (
            0 if item["featured"] else 1,
            item["order"],
            -item["date"].timestamp(),
        )
    )
    return visible


def load_page(content_dir: str, name: str):
    """加载独立页面，例如 about.md。"""
    file_path = os.path.join(content_dir, "pages", f"{name}.md")
    if not os.path.isfile(file_path):
        return None

    data, body, _stat, _fallback = _read_source(file_path)
    rendered = render_markdown(body)
    plain = html_to_plain_text(rendered["html"])

    return {
        "title": str(data["title"]) if data.get("title") else name,
        "subtitle": str(data["subtitle"]) if data.get("subtitle") else "",
        "html": rendered["html"],
        "toc": rendered["toc"],
        "plain": plain,
        "reading_time": reading_time(plain),
    }


def collect_tags(posts: list[dict]) -> list[dict]:
    """汇总 标签 -> 文章数。"""
    counts: dict[str, int] = {}
    for post in posts:
        for tag in post["tags"]:
            counts[tag] = counts.get(tag, 0) + 1

    items = [{"name": name, "slug": slugify(name), "count": count} for name, count in counts.items()]
    items.sort(key=lambda tag: (-tag["count"], tag["name"]))
    return items
