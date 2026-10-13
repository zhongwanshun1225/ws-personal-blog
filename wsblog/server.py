"""本地预览服务器。

Python 标准库没有跨平台的文件监听 API，这里用轻量的 mtime 轮询实现
「改文件 → 自动重建 → 刷新浏览器即可看到效果」。
"""

from __future__ import annotations

import http.server
import os
import socketserver
import threading
import time
from functools import partial

__all__ = ["serve", "watch_and_rebuild"]

# 覆盖 MIME 表：Windows 上注册表常把 .js 判成 text/plain，会让模块脚本失效
_EXTRA_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".mp4": "video/mp4",
    "": "application/octet-stream",
}


class BlogRequestHandler(http.server.SimpleHTTPRequestHandler):
    """静态文件服务：无扩展名时回退到 .html，找不到时渲染 404 页。"""

    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **_EXTRA_TYPES}

    def end_headers(self):
        # 预览场景下禁用缓存，避免改完看不到效果
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        resolved = super().translate_path(path)
        if os.path.isfile(resolved):
            return resolved
        if not os.path.splitext(resolved)[1]:
            if os.path.isfile(resolved + ".html"):
                return resolved + ".html"
            index = os.path.join(resolved, "index.html")
            if os.path.isfile(index):
                return index
        return resolved

    def send_error(self, code, message=None, explain=None):
        if code == 404:
            page = os.path.join(str(self.directory), "404.html")
            if os.path.isfile(page):
                with open(page, "rb") as handle:
                    body = handle.read()
                self.send_response(404)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
                return
        super().send_error(code, message, explain)

    def log_message(self, format, *args):  # noqa: A002 —— 沿用基类签名
        # 只留下最简的一行，避免刷屏
        print(f"  {self.address_string()} · {format % args}")


def _snapshot(directories) -> dict:
    state = {}
    for directory in directories:
        for root, _dirs, files in os.walk(directory):
            for name in files:
                full = os.path.join(root, name)
                try:
                    state[full] = os.stat(full).st_mtime_ns
                except OSError:
                    continue
    return state


def watch_and_rebuild(directories, rebuild, interval: float = 1.0, lock=None) -> None:
    """轮询目录快照，发现变化就重新构建。"""
    previous = _snapshot([d for d in directories if os.path.isdir(d)])
    while True:
        time.sleep(interval)
        try:
            current = _snapshot([d for d in directories if os.path.isdir(d)])
        except OSError:
            continue
        if current != previous:
            previous = current
            try:
                if lock is not None:
                    with lock:
                        rebuild()
                else:
                    rebuild()
            except Exception as exc:  # noqa: BLE001
                print(f"✗ 重新构建失败：{exc}")


def watch_cloud_rebuild(fetch_fingerprint, rebuild, interval: float = 60.0, lock=None) -> None:
    """轮询云端内容指纹（已发布文章的数量与最新 updated_at），变化即重建。

    这是「后台发布 → 全站生效」的扳机：不需要任何部署密钥或 webhook，
    服务进程自己发现云端内容变了就把静态页全部重写（含首页统计、
    搜索索引、RSS、sitemap、云文章的静态详情页）。指纹拉取失败
    （离线/超时）时静默跳过，不影响正在运行的站点。
    """
    try:
        last = fetch_fingerprint()
    except Exception:  # noqa: BLE001
        last = None
    while True:
        time.sleep(interval)
        try:
            current = fetch_fingerprint()
        except Exception:  # noqa: BLE001
            continue
        if current is None or current == last:
            continue
        last = current
        print("· 检测到云端文章变化，正在重新构建…")
        try:
            if lock is not None:
                with lock:
                    rebuild()
            else:
                rebuild()
            print("✓ 云端内容重建完成")
        except Exception as exc:  # noqa: BLE001
            print(f"✗ 云端内容重建失败：{exc}")


def serve(
    dist_dir,
    port: int = 4173,
    rebuild=None,
    watch_dirs=None,
    host: str = "127.0.0.1",
    cloud_check=None,
    cloud_interval: float = 60.0,
) -> None:
    """启动预览服务器。

    ``rebuild`` + ``watch_dirs`` 开启「本地文件变化 → 重建」；
    ``cloud_check`` 开启「云端内容变化 → 重建」（发布即生效）。
    两者共用一把互斥锁，避免同时构建互相踩到 dist/。
    """
    handler = partial(BlogRequestHandler, directory=str(dist_dir))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer((host, port), handler)
    httpd.daemon_threads = True

    build_lock = threading.Lock()
    if rebuild and watch_dirs:
        watcher = threading.Thread(
            target=watch_and_rebuild, args=(watch_dirs, rebuild),
            kwargs={"lock": build_lock}, daemon=True,
        )
        watcher.start()
    if rebuild and cloud_check:
        cloud_watcher = threading.Thread(
            target=watch_cloud_rebuild, args=(cloud_check, rebuild),
            kwargs={"interval": cloud_interval, "lock": build_lock}, daemon=True,
        )
        cloud_watcher.start()

    print(f"\n▸ 本地预览：http://localhost:{port}")
    print("  文件变更会自动重新构建，刷新浏览器即可看到效果。\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n· 已停止预览服务")
    finally:
        httpd.server_close()
