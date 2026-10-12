"""页面外壳：<head>、顶栏、页脚、搜索面板、脚本挂载点。

所有页面共用这一层，保证导航与元信息一致。
"""

from __future__ import annotations

import json
from datetime import datetime
from urllib.parse import quote

from ..util import escape_html as esc

__all__ = ["layout", "render_social", "icons"]

# ---------- 内联图标（不依赖图标库，无额外请求） ----------
icons = {
    "github": (
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">'
        '<path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54'
        "-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96"
        ".1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 "
        ".97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.19 1.84 "
        '1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12'
        'C23.5 5.73 18.27.5 12 .5Z"/></svg>'
    ),
    "mail": (
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4.5" width="19" '
        'height="15" rx="2.5"/><path d="m3 7 9 6 9-6"/></svg>'
    ),
    "rss": (
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 '
        '0 1 16 16"/><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg>'
    ),
    "link": (
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M10.5 13.5a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5"/>'
        '<path d="M13.5 10.5a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5"/></svg>'
    ),
    "search": (
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" '
        'stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
    ),
    "menu": (
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" '
        'stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'
    ),
    "close": (
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" '
        'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
    ),
    "up": (
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>'
    ),
    "back": (
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>'
    ),
    "external": (
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 5h5v5"/>'
        '<path d="M19 5l-8.5 8.5"/><path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4"/></svg>'
    ),
    "sparkle": (
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">'
        '<path d="M12 2.5 13.9 9 20 11l-6.1 2L12 19.5 10.1 13 4 11l6.1-2Z"/></svg>'
    ),
}


def _is_http(url) -> bool:
    text = str(url or "").lower()
    return text.startswith("http://") or text.startswith("https://")


def render_social(social=None) -> str:
    """社交链接：已知图标用图标，未知的退化为文字标签。"""
    parts = []
    for item in social or []:
        url = item.get("url") or ""
        label = item.get("label") or ""
        attrs = ' target="_blank" rel="noopener noreferrer"' if _is_http(url) else ""
        icon = icons.get(item.get("icon"))
        if icon:
            parts.append(
                f'<a class="icon-link" href="{esc(url)}"{attrs} title="{esc(label)}" '
                f'aria-label="{esc(label)}">{icon}</a>'
            )
        else:
            parts.append(
                f'<a class="icon-link" href="{esc(url)}"{attrs} title="{esc(label)}">{esc(label)}</a>'
            )
    return "".join(parts)


def build_favicon(config: dict) -> str:
    """生成一个内联 SVG favicon，避免额外文件请求。"""
    initial = esc(str(config.get("title") or "B").strip()[:1].upper())
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#34d399"/>'
        "</linearGradient></defs>"
        '<rect width="64" height="64" rx="15" fill="url(#g)"/>'
        '<text x="32" y="44" font-family="ui-monospace,Consolas,monospace" font-size="36" font-weight="700" '
        f'text-anchor="middle" fill="#04211e">{initial}</text></svg>'
    )
    return "data:image/svg+xml," + quote(svg, safe="")


def layout(
    *,
    config: dict,
    title: str,
    description: str = "",
    content: str = "",
    root: str = "",
    current: str = "",
    canonical: str = "",
    body_class: str = "",
    extra_head: str = "",
    show_progress: bool = False,
) -> str:
    """渲染完整页面。"""
    site_title = config.get("title") or "Blog"
    page_title = f"{title} · {site_title}" if title and title != site_title else site_title
    desc = description or config.get("description") or ""

    site_url = str(config.get("url") or "").rstrip("/") if config.get("url") else ""
    url = f"{site_url}{canonical}" if site_url and canonical else ""

    # ---------- 导航 ----------
    nav_parts, mobile_nav_parts = [], []
    for item in config.get("nav") or []:
        active = bool(current) and item.get("url") == current
        aria = ' aria-current="page"' if active else ""
        item_url = esc(item.get("url"))
        item_label = esc(item.get("label"))
        nav_parts.append(f'<a class="nav__link" href="{root}{item_url}"{aria}>{item_label}</a>')
        mobile_nav_parts.append(f'<a href="{root}{item_url}"{aria}>{item_label}</a>')
    nav_html = "".join(nav_parts)
    mobile_nav_html = "".join(mobile_nav_parts)

    # ---------- 页脚 / 元信息 ----------
    year = datetime.now().year
    start_year = config.get("since") or year
    year_text = f"{start_year}–{year}" if start_year < year else f"{year}"

    keywords = config.get("keywords") or []
    keywords_meta = (
        f'<meta name="keywords" content="{esc(",".join(str(k) for k in keywords))}">' if keywords else ""
    )
    canonical_meta = f'<link rel="canonical" href="{esc(url)}">' if url else ""
    og_url_meta = f'<meta property="og:url" content="{esc(url)}">' if url else ""

    footer = config.get("footer") or {}
    author = esc(config.get("author") or site_title)
    footer_note = f' · {esc(footer.get("note"))}' if footer.get("note") else ""
    icp_block = f'<div>{esc(footer.get("icp"))}</div>' if footer.get("icp") else ""
    social_html = render_social(config.get("social") or [])

    body_attr = f' class="{esc(body_class)}"' if body_class else ""
    progress_html = '<div class="read-progress" id="readProgress"></div>' if show_progress else ""
    brand_initial = esc(str(site_title).strip()[:1].upper())

    return f"""<!DOCTYPE html>
<html lang="{esc(config.get("lang") or "zh-CN")}" data-root="{root}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(page_title)}</title>
<meta name="description" content="{esc(desc)}">
<meta name="author" content="{esc(config.get("author") or "")}">
{keywords_meta}
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0c11">
<meta name="generator" content="WS Blog (static generator)">
{canonical_meta}
<meta property="og:type" content="website">
<meta property="og:site_name" content="{esc(site_title)}">
<meta property="og:title" content="{esc(page_title)}">
<meta property="og:description" content="{esc(desc)}">
{og_url_meta}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(page_title)}">
<meta name="twitter:description" content="{esc(desc)}">
<link rel="icon" href="{build_favicon(config)}">
<link rel="alternate" type="application/rss+xml" title="{esc(site_title)} RSS" href="{root}feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{root}assets/main.css">
{extra_head}
<script>window.__ROOT__={json.dumps(root)};</script>
</head>
<body{body_attr}>
<a class="skip-link" href="#main" style="position:absolute;left:-9999px">跳到主要内容</a>
{progress_html}

<header class="site-header">
  <div class="wrap site-header__inner">
    <a class="brand" href="{root}index.html">
      <span class="brand__mark">{brand_initial}</span>
      <span class="brand__text">{esc(site_title)}</span>
    </a>
    <nav class="nav" aria-label="主导航">{nav_html}</nav>
    <span class="header__spacer"></span>
    <div class="header__actions">
      <button class="search-trigger" type="button" data-search-open aria-label="搜索站内内容">
        {icons["search"]}<span>搜索</span><kbd>Ctrl K</kbd>
      </button>
      {social_html}
      <button class="nav-toggle" type="button" data-nav-toggle aria-label="展开菜单" aria-expanded="false">{icons["menu"]}</button>
    </div>
  </div>
</header>
<nav class="mobile-nav" data-mobile-nav aria-label="移动端导航">{mobile_nav_html}</nav>

<main id="main">
{content}
</main>

<footer class="site-footer">
  <div class="wrap site-footer__inner">
    <div class="site-footer__left">
      <div>© {year_text} {author}{footer_note}</div>
      {icp_block}
    </div>
    <div class="site-footer__right">{social_html}</div>
  </div>
</footer>

<button class="to-top" type="button" data-to-top aria-label="回到顶部">{icons["up"]}</button>

<div class="search-overlay" data-search-overlay role="dialog" aria-modal="true" aria-label="站内搜索">
  <div class="search-panel">
    <div class="search-panel__field">
      {icons["search"]}
      <input class="search-panel__input" type="search" placeholder="搜索文章、项目、标签…" data-search-input autocomplete="off" spellcheck="false">
      <span class="search-panel__esc">ESC</span>
    </div>
    <div class="search-results" data-search-results></div>
    <div class="search-hint"><span>↑↓ 选择</span><span>↵ 打开</span><span>ESC 关闭</span></div>
  </div>
</div>

<div class="toast" data-toast role="status" aria-live="polite"></div>
<script src="{root}assets/app.js" defer></script>
</body>
</html>"""
