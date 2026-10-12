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

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from wsblog.util import parse_date

REST_FIELDS = "id,slug,title,summary,tags,status,published_at,created_at,content_md"

_FENCE_RE = re.compile(r"```[^\n]*\n?|~~~[^\n]*\n?")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MARK_RE = re.compile(r"(^#{1,6}\s+|[*_`>~]+|^\s*[-+*]\s+|^\s*\d+\.\s+)")

__all__ = ["fetch_published_cloud_posts", "markdown_to_plain"]


def markdown_to_plain(md: str = "") -> str:
    """把 Markdown 源码粗略压成纯文本（用于搜索索引与摘要，不求完美）。"""
    text = md or ""
    text = _FENCE_RE.sub("\n", text)
    text = _IMAGE_RE.sub(r"\1", text)
    text = _LINK_RE.sub(r"\1", text)
    text = _MARK_RE.sub("", text)
    return re.sub(r"\n{2,}", "\n", text).strip()


def _normalize_row(row: dict) -> dict | None:
    slug = str(row.get("slug") or "").strip()
    title = str(row.get("title") or "").strip()
    if not slug or not title:
        return None

    raw_date = row.get("published_at") or row.get("created_at")
    date = parse_date(raw_date) if raw_date else None
    if date is None:
        date = datetime.now(timezone.utc)

    tags_raw = row.get("tags")
    if isinstance(tags_raw, str):
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
    elif isinstance(tags_raw, (list, tuple)):
        tags = [str(t).strip() for t in tags_raw if str(t).strip()]
    else:
        tags = []

    content_md = str(row.get("content_md") or "")
    summary = str(row.get("summary") or "").strip()
    plain = markdown_to_plain(content_md)

    return {
        "type": "cloud_post",
        "title": title,
        "slug": slug,
        # 阅读页是客户端渲染的 post.html?slug=xxx
        "url": "post.html?slug=" + urllib.parse.quote(slug, safe=""),
        "date": date,
        "tags": tags,
        "summary": summary or (plain[:110] + ("…" if len(plain) > 110 else "")),
        "cover": "",
        "plain": plain,
        "content_md": content_md,
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
    *, site_origin: str, publishable_key: str, timeout: float = 8.0
) -> list[dict]:
    """拉取全部已发布的云端文章，归一化成与静态文章同形的 dict。"""
    if not site_origin or not publishable_key:
        return []

    base = site_origin.rstrip("/") + "/.cloud/database/rest/cloud_posts"
    query = urllib.parse.urlencode(
        {"select": REST_FIELDS, "status": "eq.published", "order": "published_at.desc"}
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

    items = [row for row in (_normalize_row(r) for r in payload if isinstance(r, dict)) if row]
    if items:
        print(f"· 已合并 {len(items)} 篇在线文章进全站索引")
    return items
