"""构建期拉取云端互动统计（阅读 / 点赞 / 收藏 / 评论）与最近评论。

为什么在**构建期**拉而不是浏览器实时拉：

* 列表页的「热门排序」与「互动数」要能被爬虫看到、也要在无 JS 时可用；
  这些数字烘进静态 HTML 最稳，也和「云文章构建期合流」保持同一套思路。
* 代价是数据有构建延迟 —— 有人点了赞，要等下一次重建（推送 / 后台发布
  触发 / `--serve` 的云指纹轮询）才会反映到列表页。文章详情页的**实时**
  数字仍由前端 interact.js 从云端取，两者不冲突。

数据来源（两个只读视图，见 cloud/sql/2026-10-13-batch5-visitor-gaps.sql）：

* ``post_stats_public``   —— 每个 slug 的 views / likes / bookmarks / comments
* ``comments_public``     —— 仅 ``status='visible'`` 的评论摘要（不含 PII）

⚠️ 与 cloudposts.py 同样的坑：**必须打视图，别查表**。``comments`` /
``post_likes`` / ``post_bookmarks`` 上都有 RLS，匿名直接查表会得到
HTTP 200 + ``[]``（不报错），看起来像「没有数据」。

任何失败都静默降级：统计全为 0、动态区块为空。构建绝不因云端而中断。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from wsblog import cloudcache
from wsblog.util import parse_date

__all__ = [
    "fetch_post_stats",
    "fetch_recent_comments",
    "interact_key",
    "apply_stats",
    "hot_score",
    "HOT_WEIGHTS",
]

# 热度权重：阅读是「路过」，点赞与评论是「真的在意」，所以后者给更高权重。
# 数值是拍出来的，只要求「互动能明显把文章往前推」，不追求统计学意义。
# ⚠️ 键名必须与 apply_stats 写进 post 的字段名一致（评论是 comment_count，
#    不是 comments —— 视图里的列叫 comments，两者差一个词，写错会静默失效）。
HOT_WEIGHTS = {"views": 1, "likes": 15, "bookmarks": 12, "comment_count": 25}


def interact_key(post: dict) -> str:
    """文章在云端互动体系里的 slug。

    云文章的互动记录带 ``cloud:`` 前缀（避免与静态文章同名撞车），
    静态文章就是自己的 slug —— cloudposts 归一化时写进了 interact_slug。
    """
    return str(post.get("interact_slug") or post.get("slug") or "")


def _urlopen(request: urllib.request.Request, timeout: float):
    """先按环境默认（可能含代理）请求，失败后绕过代理直连重试。"""
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except (urllib.error.URLError, TimeoutError, OSError):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return opener.open(request, timeout=timeout)


def _get_json(base: str, resource: str, query: dict, publishable_key: str, timeout: float):
    url = f"{base.rstrip('/')}/{resource}?{urllib.parse.urlencode(query)}"

    # E4：构建期云端响应缓存（TTL 5 分钟），命中则完全不发请求。
    cached = cloudcache.get(url)
    if cached is not None:
        return cached if isinstance(cached, list) else None

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
        print(f"· 云端 {resource} 拉取失败，本次构建按 0 处理（{reason}）")
        return None
    if isinstance(payload, list):
        cloudcache.put(url, payload)
        return payload
    return None


def _to_int(value) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def fetch_post_stats(
    *, site_origin: str, publishable_key: str, timeout: float = 8.0
) -> dict[str, dict]:
    """返回 ``{interact_slug: {views, likes, bookmarks, comments}}``。"""
    if not site_origin or not publishable_key:
        return {}

    payload = _get_json(
        site_origin + "/.cloud/database/rest",
        "post_stats_public",
        {"select": "post_slug,views,likes,bookmarks,comments", "limit": "5000"},
        publishable_key,
        timeout,
    )
    if payload is None:
        return {}

    stats: dict[str, dict] = {}
    for row in payload:
        if not isinstance(row, dict):
            continue
        slug = str(row.get("post_slug") or "").strip()
        if not slug:
            continue
        stats[slug] = {
            "views": _to_int(row.get("views")),
            "likes": _to_int(row.get("likes")),
            "bookmarks": _to_int(row.get("bookmarks")),
            "comments": _to_int(row.get("comments")),
        }
    if stats:
        print(f"· 已合并 {len(stats)} 条互动统计（阅读 / 点赞 / 收藏 / 评论）")
    return stats


def fetch_recent_comments(
    *, site_origin: str, publishable_key: str, limit: int = 8, timeout: float = 8.0
) -> list[dict]:
    """最近的可见评论（首页「站点动态」用）。失败返回空列表。"""
    if not site_origin or not publishable_key:
        return []

    payload = _get_json(
        site_origin + "/.cloud/database/rest",
        "comments_public",
        {
            "select": "id,post_slug,author_name,excerpt,created_at",
            "order": "created_at.desc",
            "limit": str(max(1, min(50, limit))),
        },
        publishable_key,
        timeout,
    )
    if payload is None:
        return []

    items: list[dict] = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        slug = str(row.get("post_slug") or "").strip()
        excerpt = " ".join(str(row.get("excerpt") or "").split())
        if not slug or not excerpt:
            continue
        items.append(
            {
                "id": str(row.get("id") or ""),
                "post_slug": slug,
                "author": str(row.get("author_name") or "").strip() or "读者",
                "excerpt": excerpt,
                "date": parse_date(row.get("created_at")),
            }
        )
    if items:
        print(f"· 已加载 {len(items)} 条最近评论（首页站点动态）")
    return items


def hot_score(post: dict) -> float:
    """热度分：阅读 + 点赞 + 收藏 + 评论 的加权和。

    没有任何互动数据时返回 0 —— 排序会退化为「按时间倒序」，
    而不是把页面排成随机顺序。
    """
    return sum(HOT_WEIGHTS[field] * _to_int(post.get(field)) for field in HOT_WEIGHTS)


def apply_stats(posts: list[dict], stats: dict[str, dict]) -> None:
    """把互动统计写进文章 dict（就地）。

    即使 stats 为空也要跑一遍：这样每个 post 都有 views/likes/comments
    与 hot 字段，模板可以直接取，不用到处写 ``post.get(...) or 0``。
    """
    for post in posts:
        row = stats.get(interact_key(post)) or {}
        post["views"] = _to_int(row.get("views"))
        post["likes"] = _to_int(row.get("likes"))
        post["bookmarks"] = _to_int(row.get("bookmarks"))
        post["comment_count"] = _to_int(row.get("comments"))
        post["hot"] = hot_score(post)
