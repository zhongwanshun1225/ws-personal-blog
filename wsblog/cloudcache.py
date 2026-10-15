"""构建期云端响应缓存（E4）。

问题
----
每次构建都要打 4 次云端只读接口（已发布文章 / 公开作者资料 / 站点设置 /
互动统计 + 最近评论），每次超时上限 8s。本地边写边预览时反复重建，
这些请求占了构建耗时的大头（实测全量 ~38s，其中大部分是网络往返）。
而它们的数据绝大多数时候根本没变。

做法
----
把「接口地址 + 查询参数」的哈希当 key，把响应体缓存到 `.preview/cache/cloud/`，
带一个短 TTL（默认 5 分钟）。命中且未过期就直接返回缓存内容，完全不发请求。

为什么按 TTL 而不是「手动刷新」
----------------------------
构建器不知道云端什么时候被改了 —— 后台发一篇文章、改一次站点设置，
本地这边是无感的。TTL 是这里唯一诚实的选择：
- 短到「后台改完等几分钟再构建」就能看到新数据；
- 长到连续重建（改 CSS / 调模板）不会反复打云端。

如何强制刷新
----------
- `--no-cloud-cache`（或环境变量 `WSBLOG_NO_CLOUD_CACHE=1`）跳过缓存直连；
- 或直接删掉 `.preview/cache/cloud/` 目录。

失败一律降级
----------
缓存读写任何异常都不影响构建（当作未命中）。

⚠️ 发布场景必须注意
----------------
`sites_deploy` 打包的是**整个工作区**（只排除 node_modules / .git / 构建产物），
所以 `.preview/cache/cloud/` **确实会被上传到沙箱**。若本地缓存还新鲜，
沙箱内的首次构建就会命中它，从而把「你本地那一刻的云端数据」烘进线上产物。

两道防线：
1. **TTL 只有 5 分钟**（`DEFAULT_TTL`）—— 发布流程走完上传 + 沙箱安装依赖，
   通常已远超这个窗口，缓存自然失效；
2. **`--serve` 默认禁用缓存**（见 `_enabled`）—— 而 `sites_deploy` 的启动命令正是
   `python3 build.py --serve ...`。这一条是硬的：本地怎么调都绕不过去。

本地开发照常用缓存（不带 `--serve` 的构建），发布路径自动直连。
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any

CACHE_DIR = os.path.join(".preview", "cache", "cloud")
DEFAULT_TTL = 300.0  # 5 分钟
# --serve 是发布沙箱用的启动方式（sites_deploy 的 startCmd）。
# 它的产物直接面向线上，不能接受「本地某一刻的缓存」——所以一律直连。
_serve_mode = False


def mark_serve_mode() -> None:
    """由 build.py 在 `--serve` 时调用：发布路径整体禁用缓存。"""
    global _serve_mode
    _serve_mode = True


def _enabled() -> bool:
    if _serve_mode:
        return False
    if os.environ.get("WSBLOG_NO_CLOUD_CACHE", "").strip() in {"1", "true", "yes"}:
        return False
    return True


def _cache_path(url: str) -> str:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]
    return os.path.join(CACHE_DIR, f"{digest}.json")


def get(url: str, ttl: float = DEFAULT_TTL) -> Any | None:
    """取缓存；未命中 / 过期 / 读取失败一律返回 None。"""
    if not _enabled():
        return None
    path = _cache_path(url)
    try:
        if time.time() - os.path.getmtime(path) > ttl:
            return None
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return None
    # 记下命中的 URL，便于构建结束后提示「本次有多少数据来自缓存」
    _hits.append(url)
    return payload.get("body")


def put(url: str, body: Any) -> None:
    """写缓存；任何失败都静默忽略（缓存只是加速，不该影响构建）。"""
    if not _enabled():
        return
    path = _cache_path(url)
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"url": url, "body": body, "at": time.time()}, handle, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


_hits: list[str] = []


def report() -> None:
    """打印缓存命中概要。只在有命中时输出，避免刷噪音。"""
    if not _hits:
        return
    print(f"· 云端缓存：{len(_hits)} 个接口命中（TTL {int(DEFAULT_TTL)}s，--no-cloud-cache 可直连）")


def clear() -> int:
    """清空缓存目录，返回删除的文件数。"""
    removed = 0
    try:
        for name in os.listdir(CACHE_DIR):
            if name.endswith(".json"):
                os.remove(os.path.join(CACHE_DIR, name))
                removed += 1
    except OSError:
        pass
    return removed
