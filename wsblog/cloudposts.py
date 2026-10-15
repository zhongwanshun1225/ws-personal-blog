"""构建期拉取云端已发布文章。

后台（admin.html）发布的文章存放在 ``cloud_posts`` 表里，与 ``content/`` 下的
静态文章是两个来源。这里在构建时把它们拉下来，合并进搜索索引、RSS、sitemap、
首页与标签体系，让两套内容在全站入口上保持一致。

读取方式与前端 ``src/vendor/cloud-sdk.js`` 完全一致：

* 端点：``{endpoint}/.cloud/database/rest/posts_public``（PostgREST 风格）
* 凭据：``x-wb-webapp-access-key: <publishableKey>``（可公开，只标识应用）
* 资源：走 **posts_public 视图**，不是 ``cloud_posts`` 表

⚠️ 关于「为什么必须用视图」：第二批「公开读取收敛」之后，``cloud_posts`` 上
已经没有匿名 SELECT 策略了（只剩 is_admin / author_id = auth.uid() 两条），
直接查表对匿名调用永远返回空数组 —— 而且不报错，HTTP 200 + ``[]``，非常难察觉。
本模块曾因此静默失效：云文章一篇都合并不进来。视图里只含 ``status='published'``
的行，等价于原来的 ``status=eq.published`` 过滤。

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

from wsblog import cloudcache
from wsblog.markdown import render_markdown
from wsblog.util import parse_date, reading_time

_FENCE_RE = re.compile(r"```[^\n]*\n?|~~~[^\n]*\n?")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MARK_RE = re.compile(r"(^#{1,6}\s+|[*_`>~]+|^\s*[-+*]\s+|^\s*\d+\.\s+)")
# 只有「安全 slug」才允许生成静态详情页：防止数据库里一个奇怪的 slug
# 在 write() 时变成路径穿越或文件系统不兼容的名字
_SAFE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,190}$")
# 作者主页的文件名直接取 owner_id，必须是纯数字才落盘（同样防路径穿越）
_SAFE_AUTHOR_ID_RE = re.compile(r"^[0-9]{1,32}$")

__all__ = [
    "fetch_published_cloud_posts",
    "fetch_public_profiles",
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

    # 作者署名：只有纯数字 id 才认（后面拿它拼 authors/<id>.html 的文件名）
    author_id = str(row.get("author_id") or "").strip()
    if not _SAFE_AUTHOR_ID_RE.match(author_id):
        author_id = ""

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
        "series": str(row.get("series") or "").strip(),
        "summary": summary or (plain[:110] + ("…" if len(plain) > 110 else "")),
        "cover": "",
        "plain": plain,
        "content_md": content_md,
        "html": rendered["html"],
        "toc": rendered["toc"],
        "has_math": rendered.get("has_math", False),
        "has_mermaid": rendered.get("has_mermaid", False),
        # 下面几个字段是「与静态文章同形」的补齐项：模板里的
        # _post_item / post_page 会直接取 post["reading_time"] 与 post["words"]，
        # 缺了就是构建期 KeyError —— 之前云端 0 篇时这条路没被走到，别删。
        "reading_time": reading_time(plain),
        "words": len(plain),
        "draft": False,
        "pinned": False,
        "author_id": author_id,
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

    base = site_origin.rstrip("/") + "/.cloud/database/rest/posts_public"
    query = urllib.parse.urlencode(
        {"select": ("id,slug,title,summary,tags,published_at,created_at,"
                    "updated_at,content_md,author_id"),
         "order": "published_at.desc"}
    )
    url = f"{base}?{query}"

    # E4：构建期云端响应缓存。命中时完全不发请求（本地边写边预览的场景下省下大头耗时）。
    cached = cloudcache.get(url)
    if cached is not None:
        payload = cached
    else:
        request = urllib.request.Request(
            url,
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
        cloudcache.put(url, payload)

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


def fetch_public_profiles(
    *, site_origin: str, publishable_key: str, timeout: float = 8.0
) -> dict[str, dict]:
    """拉取公开资料（``profiles_public`` 视图），返回 ``{owner_id: {nickname, avatar_url, bio}}``。

    视图里只有 active 用户，且不含邮箱等 PII（见 batch4 的 A1）。
    任何失败都返回空字典 —— 少了头像和简介不影响文章本身。
    """
    if not site_origin or not publishable_key:
        return {}

    base = site_origin.rstrip("/") + "/.cloud/database/rest/profiles_public"
    query = urllib.parse.urlencode({"select": "owner_id,nickname,avatar_url,bio"})
    url = f"{base}?{query}"

    cached = cloudcache.get(url)
    if cached is not None:
        payload = cached
    else:
        request = urllib.request.Request(
            url,
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
            print(f"· 公开资料拉取失败，本次构建不带作者信息（{reason}）")
            return {}
        cloudcache.put(url, payload)

    if not isinstance(payload, list):
        print(f"· 公开资料返回格式异常，忽略（{type(payload).__name__}）")
        return {}

    profiles: dict[str, dict] = {}
    for row in payload:
        if not isinstance(row, dict):
            continue
        owner_id = str(row.get("owner_id") or "").strip()
        if not _SAFE_AUTHOR_ID_RE.match(owner_id):
            continue
        profiles[owner_id] = {
            "owner_id": owner_id,
            "nickname": str(row.get("nickname") or "").strip(),
            "avatar_url": str(row.get("avatar_url") or "").strip(),
            "bio": str(row.get("bio") or "").strip(),
        }
    if profiles:
        print(f"· 已加载 {len(profiles)} 份公开作者资料")
    return profiles


def _count_and_stamp(
    *, base: str, select: str, extra: dict, order: str, stamp_fields: tuple[str, ...],
    publishable_key: str, timeout: float,
) -> tuple[str, str] | None:
    """取「总行数 + 前 50 行按 stamp_fields 串联的指纹」，用于变化检测。

    ``order`` 与 ``stamp_fields`` 必须指向真实存在的列 —— PostgREST 对不存在的
    排序列直接 400，这里拿不到数据就返回 None（调用方会把它记成未知）。
    """
    query = urllib.parse.urlencode({**extra, "select": select, "order": order, "limit": "50"})
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
    stamp = "|".join(
        str(row.get(field) or "") for row in payload if isinstance(row, dict) for field in stamp_fields
    )
    return total, stamp


def cloud_posts_fingerprint(
    *, site_origin: str, publishable_key: str, timeout: float = 8.0
) -> str | None:
    """计算云端「已发布文章 + 公开资料」的轻量指纹，用于「发布即重建」的变化检测。

    两件事都必须进来：新文章要重建，作者改昵称/换头像/写简介同样要重建
    （作者主页上会显示这些），漏掉后者就会出现「改了头像但线上还是旧的」。

    返回摘要字符串；两路都失败才返回 None（调用方对 None 跳过重建，
    离线时不会空转）。
    """
    if not site_origin or not publishable_key:
        return None

    root = site_origin.rstrip("/") + "/.cloud/database/rest"

    posts = _count_and_stamp(
        # 同样必须走视图：查 cloud_posts 表对匿名恒为空，指纹会永远不变
        base=f"{root}/posts_public",
        select="updated_at",
        extra={},
        order="published_at.desc",
        stamp_fields=("updated_at",),
        publishable_key=publishable_key,
        timeout=timeout,
    )
    # profiles_public 没有时间戳列，用资料字段本身当变化信号
    profiles = _count_and_stamp(
        base=f"{root}/profiles_public",
        select="nickname,avatar_url,bio",
        extra={},
        order="owner_id.asc",
        stamp_fields=("nickname", "avatar_url", "bio"),
        publishable_key=publishable_key,
        timeout=timeout,
    )
    if posts is None and profiles is None:
        return None

    parts = []
    for label, data in (("posts", posts), ("profiles", profiles)):
        parts.append(f"{label}:{'?' if data is None else data[0] + ':' + data[1]}")
    return hashlib.sha1("||".join(parts).encode("utf-8")).hexdigest()
