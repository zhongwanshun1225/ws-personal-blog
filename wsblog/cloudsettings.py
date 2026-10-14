"""构建期拉取公开站点设置 + 触发到点发布。

后台「站点设置」面板（B6 / B15）把站点标题、公告条、维护模式等写进
``site_settings`` 表。访客侧需要看到其中一部分，所以：

* **运行期**：``banner.js`` 调 RPC ``settings_public()``，站长改完立刻生效，不用重建；
* **构建期**：这里拉同一份 RPC，把值烘进静态 HTML 作为「没有 JS 时的兜底」，
  并写进 ``build-info.json`` 便于排查「线上到底是哪次构建产出的」。

另外顺带调一次 ``publish_scheduled_posts()``：把 ``status='scheduled'`` 且已到点的
文章翻成 ``published``，让通知与后台筛选也能跟上。

⚠️ 可见性本身**不依赖**这个翻转函数：``posts_public`` 视图自带
``(publish_at IS NULL OR publish_at <= now())`` 条件，即使没人调用它，
文章到点也会自动出现在前台。这条自愈路径是本批（A3）的核心设计。

任何失败一律降级为空设置 / 静默跳过，构建绝不因云端而中断。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

__all__ = [
    "fetch_public_settings",
    "publish_due_posts",
    "announcement_of",
    "maintenance_of",
    "site_identity_of",
]


def _urlopen(request: urllib.request.Request, timeout: float):
    """先按环境默认（可能含代理）请求，失败后绕过代理直连重试。"""
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except (urllib.error.URLError, TimeoutError, OSError):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return opener.open(request, timeout=timeout)


def _rpc(
    *,
    site_origin: str,
    publishable_key: str,
    name: str,
    payload: dict,
    timeout: float = 8.0,
):
    """调一个 PostgREST 风格的 RPC，返回解析后的 JSON；失败返回 None。"""
    if not site_origin or not publishable_key:
        return None
    url = f"{site_origin.rstrip('/')}/.cloud/database/rest/rpc/{name}"
    body = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "x-wb-webapp-access-key": publishable_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "wsblog-builder/1.0",
        },
    )
    try:
        with _urlopen(request, timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None


def fetch_public_settings(
    *, site_origin: str, publishable_key: str, timeout: float = 8.0
) -> dict:
    """拉取 ``settings_public()``（只含 is_public 白名单键），失败返回 ``{}``。"""
    payload = _rpc(
        site_origin=site_origin,
        publishable_key=publishable_key,
        name="settings_public",
        payload={},
        timeout=timeout,
    )
    if not isinstance(payload, dict):
        if payload is not None:
            print("· 站点设置返回格式异常，改用 site.config.json 的值")
        return {}
    return payload


def publish_due_posts(
    *, site_origin: str, publishable_key: str, timeout: float = 8.0
) -> int:
    """把已到点的定时文章翻成 published，返回翻转条数（失败返回 -1）。"""
    payload = _rpc(
        site_origin=site_origin,
        publishable_key=publishable_key,
        name="publish_scheduled_posts",
        payload={},
        timeout=timeout,
    )
    if isinstance(payload, bool):
        return 1 if payload else 0
    if isinstance(payload, int):
        return payload
    return -1


def _text(value, fallback: str = "") -> str:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return fallback
    return str(value).strip() or fallback


def site_identity_of(settings: dict) -> dict:
    """从公开设置里取站点标识；缺项留空，由调用方回落到 site.config.json。"""
    settings = settings or {}
    return {
        "title": _text(settings.get("site.title")),
        "tagline": _text(settings.get("site.tagline")),
        "description": _text(settings.get("site.description")),
        "keywords": _text(settings.get("site.keywords")),
        "footer_icp": _text(settings.get("site.footer_icp")),
        "contact_email": _text(settings.get("contact.email")),
    }


def announcement_of(settings: dict) -> dict:
    """规范化公告条配置 → ``{active, text, level, until}``。"""
    raw = (settings or {}).get("banner.announcement")
    if not isinstance(raw, dict):
        return {"active": False, "text": "", "level": "info", "until": ""}
    text = _text(raw.get("text"))
    level = _text(raw.get("level"), "info").lower()
    if level not in ("info", "warn", "success"):
        level = "info"
    return {
        "active": bool(raw.get("active")) and bool(text),
        "text": text,
        "level": level,
        "until": _text(raw.get("until")),
    }


def maintenance_of(settings: dict) -> dict:
    """规范化维护模式配置 → ``{active, message, allow_admin}``。"""
    raw = (settings or {}).get("banner.maintenance")
    if not isinstance(raw, dict):
        return {"active": False, "message": "", "allow_admin": True}
    return {
        "active": bool(raw.get("active")),
        "message": _text(raw.get("message")),
        "allow_admin": raw.get("allow_admin") is not False,
    }
