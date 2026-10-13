"""构建期拉取云端已发布文章。

后台（admin.html）发布的文章存放在 ``cloud_posts`` 表里，与 ``content/`` 下的
静态文章是两个来源。这里在构建时把它们拉下来，合并进搜索索引、RSS、sitemap、
首页与标签体系，让两套内容在全站入口上保持一致。

读取方式与前端 ``src/vendor/cloud-sdk.js`` 完全一致：

* 端点：``{endpoint}/.cloud/database/rest/cloud_posts``（PostgREST 风格）
* 凭据：``x-wb-webapp-access-key: <publishableKey>``（可公开，只标识应用）
* 权限：数据库 RLS 的 ``posts_public_read`` 策略保证只能读到 ``published`` 行

任何失败（断网、超时、格式异常）都返回空列表 —— 构建绝不因云端而中断，
只是暂时少合并一批在线文章。
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from wsblog.markdown import render_markdown
from wsblog.util import parse_date

_FENCE_RE = re.compile(r"```[^\n]*\n?|~~~[^\n]*\n?")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MARK_RE = re.compile(r"(^#{1,6}\s+|[*_`>~]+|^\s*[-+*]\s+|^\s*\d+\.\s+)")
# 只有「安全 slug」才允许生成静态详情页：防止数据库里一个奇怪的 slug
# 在 write() 时变成路径穿越或文件系统不兼容的名字
_SAFE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,190}$")

__all__ = [
    "fetch_published_cloud_posts",
    "cloud_posts_fingerprint",
    "markdown_to_plain",
]


def markdown_to_plain(md: str = "") -> str:
    """把 Markdown 源码粗略压成纯文本（用于搜索索引与摘要，不求完美）。"""
    text = md or ""
    text = _FENCE_RE.sub("\n", text)
    text = _IMAGE_RE.sub(r"\1", text)
    text = _LINK_RE.sub(r"\1", text)
    text = _MARK_RE.sub("", text)
    return re.sub(r"\n{2,}", "\n", text).strip()


def _normalize_row(row: dict, static_slugs: set[str] | None = None) -> dict | None:
    slug = str(row.get("slug") or "").strip()
    title = str(row.get("title") or "").strip()
    if not slug or not title:
        return None

    raw_date = row.get("published_at") or row.get("created_at")
    date = parse_date(raw_date) if raw_date else None
    if date is None:
        date = datetime.now(timezone.utc)

    raw_updated = row.get("updated_at")
    updated = parse_date(raw_updated) if raw_updated else None

    tags_raw = row.get("tags")
    if isinstance(tags_raw, str):
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
    elif isinstance(tags_raw, (list, tuple)):
        tags = [str(t).strip() for t in tags_raw if str(t).strip()]
    else:
        tags = []

    content_md = str(row.get("content_md") or "")
    summary = str(row.get("summary") or "").strip()
    rendered = render_markdown(content_md)
    plain = markdown_to_plain(content_md)

    # 详情页优先落一份静态 HTML（爬虫可见 + 统一 URL 风格）；slug 与静态文章
    # 冲突或格式不安全时退回客户端渲染的 post.html?slug=
    if _SAFE_SLUG_RE.match(slug) and not (static_slugs and slug in static_slugs):
        url = f"posts/{slug}.html"
    else:
        url = "post.html?slug=" + urllib.parse.quote(slug, safe="")

    return {
        "type": "cloud_post",
        "title": title,
        "slug": slug,
        # 互动（评论/点赞/浏览量）永远以云端数据为准，slug 带命名空间前缀
        "interact_slug": "cloud:" + slug,
        "url": url,
        "date": date,
        "updated": updated,
        "tags": tags,
        "summary": summary or (plain[:110] + ("…" if len(plain) > 110 else "")),
        "cover": "",
        "plain": plain,
        "content_md": content_md,
        "html": rendered["html"],
        "toc": rendered["toc"],
    }


def _urlopen(request: urllib.request.Request, timeout: float):
    """先按环境默认（可能含代理）请求，失败后绕过代理直连重试。

    本机沙箱常注入不可用的 HTTP(S)_PROXY，而 GitHub Actions 等环境则直连即可，
    两边都能覆盖。
    """
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except (urllib.error.URLError, TimeoutError, OSError):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return opener.open(request, timeout=timeout)


def fetch_published_cloud_posts(
    *,
    site_origin: str,
    publishable_key: str,
    timeout: float = 8.0,
    static_slugs: set[str] | None = None,
) -> list[dict]:
    """拉取全部已发布的云端文章，归一化成与静态文章同形的 dict。"""
    if not site_origin or not publishable_key:
        return []

    base = site_origin.rstrip("/") + "/.cloud/database/rest/cloud_posts"
    query = urllib.parse.urlencode(
        {"select": "id,slug,title,summary,tags,status,published_at,created_at,updated_at,content_md",
         "status": "eq.published", "order": "published_at.desc"}
    )
    request = urllib.request.Request(
        f"{base}?{query}",
        headers={
            "x-wb-webapp-access-key": publishable_key,
            "Accept": "application/json",
            "User-Agent": "wsblog-builder/1.0",
        },
    )
    try:
        with _urlopen(request, timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        reason = getattr(exc, "reason", None) or exc
        print(f"· 云端文章拉取失败，本次构建不合并在线文章（{reason}）")
        return []

    if not isinstance(payload, list):
        print(f"· 云端文章返回格式异常，忽略（{type(payload).__name__}）")
        return []

    items = [
        row
        for row in (_normalize_row(r, static_slugs) for r in payload if isinstance(r, dict))
        if row
    ]
    if items:
        print(f"· 已合并 {len(items)} 篇在线文章进全站索引")
    return items


def cloud_posts_fingerprint(
    *, site_origin: str, publishable_key: str, timeout: float = 8.0
) -> str | None:
    """计算云端已发布文章的轻量指纹，用于「发布即重建」的变化检测。

    返回 ``数量 + 最新 updated_at`` 的摘要；任何失败都返回 None
    （调用方对 None 跳过重建，离线时不会空转）。
    """
    if not site_origin or not publishable_key:
        return None

    base = site_origin.rstrip("/") + "/.cloud/database/rest/cloud_posts"
    query = urllib.parse.urlencode(
        {"select": "updated_at", "status": "eq.published",
         "order": "updated_at.desc", "limit": "50"}
    )
    request = urllib.request.Request(
        f"{base}?{query}",
        headers={
            "x-wb-webapp-access-key": publishable_key,
            "Accept": "application/json",
            "Prefer": "count=exact",
            "User-Agent": "wsblog-builder/1.0",
        },
    )
    try:
        with _urlopen(request, timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            total = response.headers.get("Content-Range", "").split("/")[-1]
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None
    if not isinstance(payload, list):
        return None

    stamp = "|".join(str(row.get("updated_at") or "") for row in payload if isinstance(row, dict))
    return hashlib.sha1(f"{total}:{stamp}".encode("utf-8")).hexdigest()
