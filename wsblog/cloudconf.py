"""云端（WorkBuddy 云服务）配置读取与前端注入。

``cloud.config.json`` 是唯一来源：
  · 构建时据此生成 ``assets/cloud-config.js``（前端读 window.__CLOUD__）
  · 页面 <head> 里的 CDN 依赖地址也从这里取，避免地址散落在模板里

配置缺失时一切降级为「无云能力」，站点仍然是一份可用的纯静态博客。
"""

from __future__ import annotations

import json
import os

__all__ = [
    "load_cloud_config",
    "cloud_enabled",
    "vendor_url",
    "build_cloud_config_js",
]

_ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_FILE = os.path.join(_ROOT_DIR, "cloud.config.json")

_cache: dict = {}


def load_cloud_config() -> dict:
    if "cfg" not in _cache:
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
                _cache["cfg"] = json.load(handle)
        except (OSError, ValueError):
            _cache["cfg"] = {}
    return _cache["cfg"]


def cloud_enabled() -> bool:
    """有 endpoint + publishableKey 才算接入成功。"""
    cfg = load_cloud_config()
    return bool(cfg.get("endpoint") and cfg.get("publishableKey"))


def vendor_url(name: str) -> str:
    vendor = load_cloud_config().get("vendor") or {}
    return str(vendor.get(name) or "")


def build_cloud_config_js(site_config: dict | None = None, *, site_origin: str = "") -> str:
    """生成 assets/cloud-config.js 的内容。"""
    cfg = load_cloud_config()
    site = site_config or {}
    payload = {
        "applicationId": cfg.get("applicationId", ""),
        "endpoint": cfg.get("endpoint", ""),
        "oauthRelayBaseUrl": cfg.get("oauthRelayBaseUrl", ""),
        "publishableKey": cfg.get("publishableKey", ""),
        # 登录服务会校验请求 Origin，前端用它提前给出提示
        "siteOrigin": site_origin or cfg.get("siteOrigin", ""),
        "siteName": site.get("title", ""),
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return (
        "/* 本文件由 build.py 自动生成，请勿手改；改 cloud.config.json 后重新构建。 */\n"
        f"window.__CLOUD__ = {body};\n"
    )
