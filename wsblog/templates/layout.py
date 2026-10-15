"""页面外壳：<head>、顶栏、页脚、搜索面板、脚本挂载点。

所有页面共用这一层，保证导航与元信息一致。
"""

from __future__ import annotations

import json
from datetime import datetime
from urllib.parse import quote

from ..cloudconf import vendor_url
from ..i18n import LANGS, LANG_ENDONYMS, LANG_LABELS, T, normalize_lang
from ..util import escape_html as esc

__all__ = [
    "layout",
    "render_social",
    "render_appearance",
    "render_mirror_redirect",
    "breadcrumb_nav",
    "breadcrumb_json_ld",
    "i18n_config_attr",
    "lazy_img",
    "icons",
]

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
    "palette": (
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-.8.7-1.5 '
        '1.5-1.5H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7Z"/>'
        '<circle cx="7.6" cy="12.2" r="1.15" fill="currentColor" stroke="none"/>'
        '<circle cx="10.8" cy="8" r="1.15" fill="currentColor" stroke="none"/>'
        '<circle cx="15.4" cy="9.1" r="1.15" fill="currentColor" stroke="none"/></svg>'
    ),
}

# 首屏防闪烁：必须在样式表之前定稿 data-theme，否则会先闪一下深色再变浅色。
# 存储为空时默认跟随系统（mode=auto）。
THEME_BOOT = (
    "<script>(function(){var d=document.documentElement;var m='auto',a='';"
    "try{var s=JSON.parse(localStorage.getItem('wsblog:appearance')||'{}')||{};"
    "if(s.mode==='light'||s.mode==='dark'||s.mode==='auto'){m=s.mode;}"
    "if(typeof s.accent==='string'){a=s.accent;}}catch(e){}"
    "var dark=m==='dark'||(m==='auto'&&!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)')"
    ".matches));d.setAttribute('data-theme',dark?'dark':'light');"
    "if(a&&a!=='teal'){d.setAttribute('data-accent',a);}})();</script>"
)


# 界面语言预判（V13）。放在 <head> 里、样式之前执行：
#   1. 把 <html data-lang> 提前设成访客真正要看的语言；
#   2. 若与站点默认语言不同，给 <html> 打上 data-lang-switching，
#      配合 main.css 里的一条规则把 [data-i18n] 暂时藏起来，避免「先中文后英文」的闪动。
# ⚠️ 安全绳：这个内联脚本**自己**兜一个 1.5s 的定时器摘掉 data-lang-switching，
#    这样即便 assets/i18n.js 因为任何原因没跑起来，文案也不会永久隐形。
#    JS 关闭的情况由 <noscript> 里的一条 !important 规则兜底。
I18N_BOOT = (
    "<script>(function(){var d=document.documentElement;"
    "var def=d.getAttribute('data-lang-default')||'zh-CN';"
    "function norm(v){v=String(v||'').toLowerCase().replace('_','-');"
    "if(v.indexOf('en')===0)return 'en';if(v.indexOf('zh')===0)return 'zh-CN';return '';}"
    "var lang='';try{var m=/[?&]lang=([^&#]+)/.exec(location.search);"
    "if(m)lang=norm(decodeURIComponent(m[1]));"
    "if(!lang)lang=norm(localStorage.getItem('wsblog:lang'));}catch(e){}"
    "lang=lang||def;d.setAttribute('data-lang',lang);d.lang=lang;"
    "if(lang!==def){d.setAttribute('data-lang-switching','');"
    "setTimeout(function(){d.removeAttribute('data-lang-switching');},1500);}})();</script>"
)

# data-lang-switching 期间藏起待替换的文案节点。只在「语言与默认不同」时才生效，
# 中文访客（绝大多数）完全不受影响。noscript 里的 !important 规则保证 JS 关闭时正常显示。
I18N_GUARD_CSS = (
    '<noscript><style>[data-i18n],[data-i18n-attr]{visibility:visible !important}</style></noscript>'
)


# 安全兜底（meta 形式的 CSP）。这几条不需要放宽任何现有脚本，但正好堵死两条
# 真实可利用的路径：
#   form-action 'none' —— 正文里伪造的 <form action="https://evil.example"> 登录框无处投递
#   base-uri   'none'  —— 阻止注入 <base> 改写全站相对链接
# 说明：
#   · frame-ancestors（防点击劫持）meta 无法表达，需要在托管侧加响应头；
#   · 刻意不设 default-src / script-src / connect-src：页面有三处内联脚本，
#     且要访问云数据库，收紧前需要先把内联脚本改成 'sha256-…' 白名单。
CSP_META = (
    '<meta http-equiv="Content-Security-Policy" content="'
    "base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; "
    "img-src 'self' data: blob: https:"
    '">'
)


def render_mirror_redirect(config: dict) -> str:
    """镜像域名自动跳到正式域名（放在 <head> 最前面，越早执行闪动越小）。

    云端按 Origin 精确放行，一个应用只认一个域名，所以 GitHub Pages 那份
    连不上云端（登录 / 互动 / 后台全部 403）。这里让镜像域名的访问者直接
    落到正式域名，功能就是完整的。

    site.config.json 配置（hostSuffix 为空即关闭）：

        "mirror": { "hostSuffix": "github.io", "basePath": "/ws-personal-blog" }

    hostSuffix —— 命中该后缀的主机名会被重定向
    basePath   —— 镜像域名下站点根的路径前缀，会被剥掉再拼到 config.url 上
                  （GitHub Pages 项目站的地址形如 /<仓库名>/）

    带 ``?mirror=off`` 访问可停留原处（方便对比两种部署的差异）。
    """
    mirror = config.get("mirror") or {}
    host_suffix = str(mirror.get("hostSuffix") or "").strip().lower().lstrip(".")
    target = str(config.get("url") or "").rstrip("/")
    if not host_suffix or not target:
        return ""

    base_path = "/" + str(mirror.get("basePath") or "").strip("/")
    if base_path == "/":
        base_path = ""

    return (
        "<script>(function(){"
        "if(/[?&]mirror=off(?:&|$)/.test(location.search))return;"
        f"var s={json.dumps(host_suffix)},h=location.hostname.toLowerCase();"
        "if(h!==s&&h.slice(-(s.length+1))!=='.'+s)return;"
        f"var b={json.dumps(base_path)},p=location.pathname;"
        "if(b&&p.indexOf(b)===0){p=p.slice(b.length);}"
        "if(!p||p.charAt(0)!=='/'){p='/'+p;}"
        f"location.replace({json.dumps(target)}+p+location.search+location.hash);"
        "})();</script>"
    )


# 外观选择器：主题模式 + 强调色，二者都存进 localStorage
APPEARANCE_SWATCHES = (
    ("teal", "#2dd4bf", "青绿"),
    ("blue", "#60a5fa", "天蓝"),
    ("violet", "#a78bfa", "紫罗兰"),
    ("amber", "#fbbf24", "琥珀"),
    ("rose", "#fb7185", "玫红"),
)


def render_appearance(lang: str = "zh-CN") -> str:
    """顶栏的外观设置按钮 + 弹出面板（文案可切换）。"""
    def _t(key: str, **kw) -> str:
        return T(key, lang, **kw)

    checks = "".join(
        f'<button class="swatch" type="button" role="radio" '
        f'aria-checked="{"true" if key == "teal" else "false"}" '
        f'data-appearance-accent="{key}" aria-label="{esc(label)}" title="{esc(label)}" '
        f'style="--sw:{color}"></button>'
        for key, color, label in APPEARANCE_SWATCHES
    )
    return (
        '<div class="appearance" data-appearance>'
        '<button class="appearance-trigger" type="button" data-appearance-open aria-expanded="false" '
        f'aria-label="{esc(_t("appearance.title"))}" title="{esc(_t("appearance.title"))}">{icons["palette"]}</button>'
        f'<div class="appearance-panel" data-appearance-panel hidden role="group" '
        f'aria-label="{esc(_t("appearance.title"))}">'
        '<div class="appearance-group">'
        f'<span class="appearance-label" data-i18n="appearance.theme">{esc(_t("appearance.theme"))}</span>'
        f'<div class="seg" role="radiogroup" aria-label="{esc(_t("appearance.themeAria"))}">'
        '<button class="seg__btn" type="button" role="radio" aria-checked="true" '
        f'data-appearance-mode="auto" data-i18n="appearance.auto">{esc(_t("appearance.auto"))}</button>'
        '<button class="seg__btn" type="button" role="radio" aria-checked="false" '
        f'data-appearance-mode="light" data-i18n="appearance.light">{esc(_t("appearance.light"))}</button>'
        '<button class="seg__btn" type="button" role="radio" aria-checked="false" '
        f'data-appearance-mode="dark" data-i18n="appearance.dark">{esc(_t("appearance.dark"))}</button>'
        "</div>"
        "</div>"
        '<div class="appearance-group">'
        f'<span class="appearance-label" data-i18n="appearance.accent">{esc(_t("appearance.accent"))}</span>'
        f'<div class="swatches" role="radiogroup" aria-label="{esc(_t("appearance.accentAria"))}">{checks}</div>'
        "</div>"
        f'<p class="appearance-hint" data-i18n="appearance.hint">{esc(_t("appearance.hint"))}</p>'
        "</div>"
        "</div>"
    )


def render_language(lang: str = "zh-CN") -> str:
    """语言切换：一个一键切换的按钮 + 面板里的显式两选项。

    静态站点不做「每语言一套页面」，所以这里是**界面级**切换：
    文案由 assets/i18n.js 就地替换，偏好记在 localStorage，
    也接受 ``?lang=en`` 这种可分享的入口。
    """
    options = "".join(
        f'<button class="seg__btn" type="button" role="radio" '
        f'aria-checked="{"true" if code == normalize_lang(lang) else "false"}" '
        f'data-lang-set="{code}" title="{esc(LANG_ENDONYMS[code])}" '
        f'lang="{code}">{esc(LANG_ENDONYMS[code])}</button>'
        for code in LANGS
    )
    return (
        '<div class="lang" data-lang>'
        f'<button class="lang-trigger" type="button" data-lang-toggle aria-expanded="false" '
        f'data-i18n-attr="aria-label:nav.switchLang,title:nav.switchLang" '
        f'aria-label="{esc(T("nav.switchLang", lang))}" title="{esc(T("nav.switchLang", lang))}">'
        # 按钮上显示**当前**语言（面板里才是两个选项），点开才选
        f'<span data-lang-label>{esc(LANG_LABELS.get(normalize_lang(lang), "中"))}</span></button>'
        f'<div class="lang-panel" data-lang-panel hidden role="radiogroup" '
        f'aria-label="{esc(T("nav.language", lang))}">{options}</div>'
        "</div>"
    )


def _is_http(url) -> bool:
    text = str(url or "").lower()
    return text.startswith("http://") or text.startswith("https://")


def i18n_config_attr(values: dict, fallback: str = "") -> str:
    """把「来自 site.config.json 的多语言文案」写成 ``data-i18n-config`` 属性。

    导航标签、页脚说明这类内容不该塞进内置字典（它们是站点配置，不是界面文案），
    但又得跟着语言切换走。做法是构建时把各语言版本序列化成 JSON 放进属性，
    由 ``assets/i18n.js`` 的 ``apply()`` 按当前语言挑一个。

    只有一种语言可用时返回空串 —— 没有可选的东西，就没必要多写一段 DOM。
    """
    clean = {code: str(text).strip() for code, text in (values or {}).items() if str(text or "").strip()}
    if len(clean) < 2:
        return ""
    payload = json.dumps(clean, ensure_ascii=False, separators=(",", ":"))
    return f' data-i18n-config="{esc(payload)}"'


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


def breadcrumb_nav(items, root: str = "", extra: str = "") -> str:
    """统一的面包屑。

    ``items`` 是 ``[(label, url_or_None), ...]``：url 为 None 表示当前页（不可点）。
    第一项通常是「首页」，由调用方给出，这样首页自己不会出现多余的一层面包屑。
    ``extra`` 用于在末尾追加不可点的补充节点（例如归档的「第 2 页」）。

    元组可以带第三个元素（i18n key）：带上就输出 ``data-i18n``，
    界面语言切换时这一层也会跟着变（站点名、标签名这类内容本身不带 key）。
    """
    parts = ['<nav class="breadcrumb" aria-label="面包屑" data-i18n-attr="aria-label:a11y.breadcrumb">']
    for index, item in enumerate(items):
        label, url = item[0], item[1]
        key = item[2] if len(item) > 2 else None
        i18n_attr = f' data-i18n="{esc(key)}"' if key else ""
        if index > 0:
            parts.append('<span class="breadcrumb__sep">/</span>')
        if url:
            parts.append(f'<a href="{root}{esc(url)}"{i18n_attr}>{esc(label)}</a>')
        else:
            parts.append(f'<span aria-current="page"{i18n_attr}>{esc(label)}</span>')
    if extra:
        parts.append(extra)
    parts.append("</nav>")
    return "".join(parts)


def breadcrumb_json_ld(items, config: dict):
    """面包屑的结构化数据（R3 的一部分：让搜索结果能显示层级路径）。

    ``items`` 与 ``breadcrumb_nav`` 同构，但 url=None 的当前页会被跳过 ——
    BreadcrumbList 里最后一层通常是当前页，可给可不给，这里给。返回
    JSON-LD 字符串（含 ``<script>`` 标签），无配置 url 时返回空串。
    """
    site_url = str(config.get("url") or "").rstrip("/")
    if not items:
        return ""
    elements = []
    for index, item in enumerate(items, start=1):
        label, url = item[0], item[1]
        entry = {"@type": "ListItem", "position": index, "name": label}
        if url:
            entry["item"] = f"{site_url}/{url.lstrip('/')}" if site_url else url
        elif site_url:
            entry["item"] = site_url
        elements.append(entry)
    payload = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": elements,
    }
    return (
        '<script type="application/ld+json">'
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + "</script>"
    )


def lazy_img(src: str, alt: str = "", *, root: str = "", cls: str = "", eager: bool = False,
             width: str = "", height: str = "") -> str:
    """统一的图片标签：默认 ``loading="lazy" decoding="async"``。

    ``eager=True`` 用于首屏图（hero / 文章头图）—— 那些图懒加载反而会闪一下。
    ``src`` 是相对站点根的路径（如 ``assets/x.png``）或绝对 URL；
    相对路径会拼上 ``root``，这样在 ``posts/`` 这样的子目录里也指得对。
    """
    if not src:
        return ""
    url = src if _is_http(src) else f"{root}{src.lstrip('/')}"
    attrs = [
        f'src="{esc(url)}"',
        f'alt="{esc(alt)}"',
        'decoding="async"',
    ]
    if not eager:
        attrs.append('loading="lazy"')
    if width:
        attrs.append(f'width="{esc(width)}"')
    if height:
        attrs.append(f'height="{esc(height)}"')
    klass = f' class="{esc(cls)}"' if cls else ""
    return f"<img {' '.join(attrs)}{klass}>"


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
    cloud: bool = False,
    vendor: list | None = None,
    scripts: list | None = None,
    og_type: str = "website",
    og_image: str = "",
    breadcrumbs: list | None = None,
) -> str:
    """渲染完整页面。

    cloud       —— 是否接入云端（注入 cloud-config.js / SDK / cloud.js，并在顶栏放登录态插槽）
    vendor      —— 需要额外加载的库，取值 "marked" / "highlight" / "katex" / "mermaid"
                   （名字在 cloud.config.json 的 vendor 映射里解析成路径）
    scripts     —— 该页专属的本地脚本文件名（assets/ 下的相对名，按顺序注入）
    og_type     —— Open Graph 类型（列表页 website，文章详情 article）
    og_image    —— 分享缩略图。留空时用站点默认图；文章页传 cover 字段
    breadcrumbs —— [(label, url_or_None), ...]，非空时输出 BreadcrumbList 结构化数据
    """
    lang = normalize_lang(config.get("lang"))
    site_title = config.get("title") or "Blog"
    page_title = f"{title} · {site_title}" if title and title != site_title else site_title
    desc = description or config.get("description") or ""

    site_url = str(config.get("url") or "").rstrip("/") if config.get("url") else ""
    url = f"{site_url}{canonical}" if site_url and canonical else ""

    # 分享缩略图：文章封面优先，否则退回站点默认图（构建脚本会生成 og-default.png）
    image_value = str(og_image or "").strip()
    if not image_value and site_url:
        image_value = f"{site_url}/assets/og-default.png"
    image_meta = ""
    if image_value:
        image_meta = "\n".join(
            [
                f'<meta property="og:image" content="{esc(image_value)}">',
                '<meta property="og:image:width" content="1200">',
                '<meta property="og:image:height" content="630">',
                f'<meta property="og:image:alt" content="{esc(f"{site_title} 分享图")}">',
                f'<meta name="twitter:image" content="{esc(image_value)}">',
            ]
        )

    # ---------- 导航 ----------
    # nav 项支持可选的 en 字段：界面切到英文时用英文标签（没有就回落中文）。
    # 两种语言都写进 data-i18n-config，这样客户端切语言时能就地换掉，
    # 而不必刷新页面（服务端渲染的那一版只保证「没有 JS 时也对」）。
    nav_parts, mobile_nav_parts = [], []
    for item in config.get("nav") or []:
        active = bool(current) and item.get("url") == current
        aria = ' aria-current="page"' if active else ""
        item_url = esc(item.get("url"))
        label = item.get("label")
        if lang == "en" and item.get("en"):
            label = item.get("en")
        item_label = esc(label)
        alt = i18n_config_attr({"zh-CN": item.get("label"), "en": item.get("en")}, label)
        nav_parts.append(
            f'<a class="nav__link" href="{root}{item_url}"{aria}{alt}>{item_label}</a>'
        )
        mobile_nav_parts.append(f'<a href="{root}{item_url}"{aria}{alt}>{item_label}</a>')
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
    note_text = footer.get("note") or ""
    note_en = footer.get("noteEn") or footer.get("note_en") or ""
    # 页脚说明同样来自配置：中英两版都可用时挂 data-i18n-config，随语言切换。
    note_attr = i18n_config_attr({"zh-CN": note_text, "en": note_en}, note_text)
    footer_note = f' · <span{note_attr}>{esc(note_text)}</span>' if note_text else ""
    icp_block = f'<div>{esc(footer.get("icp"))}</div>' if footer.get("icp") else ""
    # 页脚固定链接（隐私政策等）。label_key 是有 i18n 的键名，label 是直接文字，
    # 两种都支持 —— 这样法律页文案能跟着界面语言切换。
    link_parts = []
    for item in footer.get("links") or []:
        if not isinstance(item, dict):
            continue
        href = str(item.get("url") or "").strip()
        key = str(item.get("label_key") or "").strip()
        label = T(key, lang) if key else str(item.get("label") or "").strip()
        if not href or not label:
            continue
        attr = f' data-i18n="{esc(key)}"' if key else ""
        link_parts.append(f'<a class="site-footer__link" href="{esc(href)}"{attr}>{esc(label)}</a>')
    legal_links_html = (
        f'<div class="site-footer__links">{"".join(link_parts)}</div>' if link_parts else ""
    )
    social_html = render_social(config.get("social") or [])

    body_attr = f' class="{esc(body_class)}"' if body_class else ""
    idle_continue = esc(T("idle.continue", lang))
    progress_html = '<div class="read-progress" id="readProgress"></div>' if show_progress else ""
    brand_initial = esc(str(site_title).strip()[:1].upper())

    # ---------- 公告条 / 维护模式（B15）----------
    # 值来自 build.py 从云端 settings_public() 拉回的公开设置（写进 config），
    # 同时允许 site.config.json 直接写死一份 —— 纯静态部署也能有公告。
    # 运行期 banner.js 会再用 RPC 校一次并就地覆盖，所以站长在后台改完
    # 立刻生效，不必等下一次构建。
    ann = config.get("announcement") if isinstance(config.get("announcement"), dict) else {}
    ann_active = bool(ann.get("active")) and bool(str(ann.get("text") or "").strip())
    ann_level = str(ann.get("level") or "info").lower()
    if ann_level not in ("info", "warn", "success"):
        ann_level = "info"
    if ann_active:
        ann_level_cls = "" if ann_level == "info" else f" announce--{ann_level}"
        announce_html = (
            f'<div class="announce{ann_level_cls}" data-announce role="region"'
            f' aria-label="{esc(T("banner.title", lang))}">'
            '<div class="wrap announce__inner">'
            '<span class="announce__dot" aria-hidden="true"></span>'
            f'<p class="announce__text" data-announce-text>{esc(ann.get("text"))}</p>'
            f'<button class="announce__close" type="button" data-announce-close'
            f' aria-label="{esc(T("banner.close", lang))}"'
            f' data-i18n-attr="aria-label:banner.close">×</button>'
            "</div></div>"
            # 公告是否已关由浏览器的 localStorage 记忆，这里先不 hidden，
            # 避免「闪一下再出现」；banner.js 首帧就会按记忆去掉它。
        )
    else:
        announce_html = '<div class="announce" data-announce hidden></div>'

    mnt = config.get("maintenance") if isinstance(config.get("maintenance"), dict) else {}
    mnt_active = bool(mnt.get("active"))
    mnt_text = str(mnt.get("message") or "").strip() or T("maintenance.default", lang)
    mnt_attr = "" if mnt_active else " hidden"
    maintenance_html = (
        f'<div class="maintenance" data-maintenance{mnt_attr} role="dialog" aria-modal="true">'
        '<div class="maintenance__card">'
        '<span class="maintenance__mark" aria-hidden="true">🛠</span>'
        f'<h2 class="maintenance__title" data-i18n="maintenance.title">{esc(T("maintenance.title", lang))}</h2>'
        f'<p class="maintenance__text" data-maintenance-text>{esc(mnt_text)}</p>'
        f'<p class="maintenance__hint" data-i18n="maintenance.adminHint">{esc(T("maintenance.adminHint", lang))}</p>'
        "</div></div>"
    )

    theme_boot = THEME_BOOT
    csp_meta = CSP_META
    mirror_script = render_mirror_redirect(config)
    appearance_html = render_appearance(lang)
    language_html = render_language(lang)
    i18n_boot = I18N_BOOT
    i18n_guard = I18N_GUARD_CSS

    # 面包屑结构化数据（R3）：可见的面包屑由各页面自己画，这里只补 <head>
    crumb_ld = breadcrumb_json_ld(breadcrumbs or [], config)
    if crumb_ld:
        extra_head = f"{extra_head}\n{crumb_ld}" if extra_head else crumb_ld

    # hreflang：界面语言是客户端切换的，所以两种语言指向同一个 URL 的不同查询参数。
    # 这样英文读者拿到的分享链接能直接以英文界面打开，也不至于让爬虫把中文正文
    # 当成英文页面（x-default 指向默认语言）。
    hreflang_meta = ""
    if url:
        hreflang_meta = "\n".join(
            [
                f'<link rel="alternate" hreflang="{code}" href="{esc(url)}'
                + (f'?lang={code}' if code != lang else "")
                + '">'
                for code in LANGS
            ]
            + [f'<link rel="alternate" hreflang="x-default" href="{esc(url)}">']
        )

    # ---------- 顶栏登录态 ----------
    # 先渲染一个静态兜底链接：即使云端 SDK 拉取失败，访客也总能找到登录入口。
    # cloud.js 就绪后会整体替换这个插槽的内容。
    if cloud:
        auth_slot = (
            '<div class="auth-slot" data-auth-slot>'
            f'<a class="auth-btn" href="{root}login.html">'
            f'<span class="auth-btn__dot"></span><span data-i18n="auth.login">{esc(T("auth.login", lang))}</span></a>'
            "</div>"
        )
        # 通知铃铛：登录后由 notify.js 渲染（未登录时保持隐藏）
        notify_slot = '<div class="notify-slot" data-notify-slot hidden></div>'
    else:
        auth_slot = ""
        notify_slot = ""

    # ---------- 脚本 ----------
    # 全部用 defer：执行顺序 = 文档顺序，所以 cloud-config → vendor → cloud.js 是可靠的。
    # vendor 地址可以是 http(s) 的 CDN，也可以是随站点打包的相对路径（assets/ 下）。
    def _vendor_src(url: str) -> str:
        if url.startswith(("http://", "https://", "//")):
            return esc(url)
        return f"{root}assets/{esc(url.lstrip('/'))}"

    script_tags = []
    # 外观设置要尽早绑定（含首屏状态同步），放在第一个
    script_tags.append(f'<script src="{root}assets/theme.js" defer></script>')
    # 界面文案切换：放在主题之后、其它脚本之前，这样切换按钮与各种文案
    # 都能在被业务脚本渲染前就位（业务脚本会通过 window.WSBlogI18n 取文案）
    script_tags.append(f'<script src="{root}assets/i18n.js" defer></script>')
    # 第三方库的地址表：math.js 要用它按需拉 KaTeX / Mermaid，
    # 而 math.js 是在 IIFE 开头就把 window.__VENDOR__ 取走的，
    # 所以这张表必须排在 math.js 前面（defer 按文档顺序执行）。
    script_tags.append(f'<script src="{root}assets/vendor-map.js" defer></script>')
    if cloud:
        script_tags.append(f'<script src="{root}assets/cloud-config.js" defer></script>')
    # vendor 里既有云端用的（marked / highlight / sdk），也有与云端无关的
    # 排版库（katex / mermaid）—— 所以这一层不再限定在 cloud 分支里
    for name in vendor or []:
        url = vendor_url(name)
        if url:
            script_tags.append(f'<script src="{_vendor_src(url)}" defer></script>')
    if cloud:
        sdk = vendor_url("sdk")
        if sdk:
            script_tags.append(f'<script src="{_vendor_src(sdk)}" defer></script>')
        script_tags.append(f'<script src="{root}assets/cloud.js" defer></script>')
        script_tags.append(f'<script src="{root}assets/notify.js" defer></script>')
        # 登录态闲置超时：依赖 cloud.js 的 currentUser/signOut/booted，
        # 必须在它之后加载；只在已登录时计时，脚本内部自判。
        script_tags.append(f'<script src="{root}assets/idle.js" defer></script>')
    script_tags.append(f'<script src="{root}assets/app.js" defer></script>')
    # 公告条 / 维护模式（B15）：构建期已烘一份兜底，这里再用 settings_public()
    # 实时校正一次，站长改完不必等重建。放在 app.js 之后、页面专属脚本之前。
    script_tags.append(f'<script src="{root}assets/banner.js" defer></script>')
    # 访问上报（B10）：只在云端可用、且非私有页面时生效，脚本内部自判。
    # 放在 banner.js 之后 —— 它只用到 cloud.js 的接口，和公告条互不依赖。
    script_tags.append(f'<script src="{root}assets/analytics.js" defer></script>')
    # 完善资料引导（M15）：依赖 app.js 提供的 __wsT 与 cloud.js 的会话状态，
    # 未登录或资料已填时直接返回，所以放在全局脚本层没有额外开销。
    script_tags.append(f'<script src="{root}assets/onboard.js" defer></script>')
    for name in scripts or []:
        script_tags.append(f'<script src="{root}assets/{esc(name)}" defer></script>')
    scripts_html = "\n".join(script_tags)

    return f"""<!DOCTYPE html>
<html lang="{esc(lang)}" data-lang-default="{esc(lang)}" data-root="{root}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
{mirror_script}
{csp_meta}
<title>{esc(page_title)}</title>
<meta name="description" content="{esc(desc)}">
<meta name="author" content="{esc(config.get("author") or "")}">
{keywords_meta}
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0a0c11">
<meta name="generator" content="WS Blog (static generator)">
{theme_boot}
{i18n_boot}
{canonical_meta}
<meta property="og:type" content="{esc(og_type)}">
<meta property="og:site_name" content="{esc(site_title)}">
<meta property="og:title" content="{esc(page_title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:locale" content="zh_CN">
{og_url_meta}
{hreflang_meta}
{image_meta}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(page_title)}">
<meta name="twitter:description" content="{esc(desc)}">
<link rel="icon" href="{build_favicon(config)}">
<link rel="apple-touch-icon" href="{root}assets/apple-touch-icon.png">
<link rel="manifest" href="{root}site.webmanifest">
<link rel="alternate" type="application/rss+xml" title="{esc(site_title)} RSS" href="{root}feed.xml">
<!-- 字体已在 assets/main.css 里以本地 @font-face 声明，不再请求 Google Fonts
     （fonts.googleapis.com / fonts.gstatic.com 在大陆不可达且阻塞渲染） -->
<link rel="stylesheet" href="{root}assets/main.css">
{i18n_guard}
{extra_head}
<script>window.__ROOT__={json.dumps(root)};</script>
</head>
<body{body_attr}>
<a class="skip-link" href="#main" data-i18n="a11y.skip" style="position:absolute;left:-9999px">{esc(T("a11y.skip", lang))}</a>
{progress_html}

<header class="site-header">
  <div class="wrap site-header__inner">
    <a class="brand" href="{root}index.html">
      <span class="brand__mark">{brand_initial}</span>
      <span class="brand__text">{esc(site_title)}</span>
    </a>
    <nav class="nav" aria-label="{esc(T("a11y.mainNav", lang))}" data-i18n-attr="aria-label:a11y.mainNav">{nav_html}</nav>
    <span class="header__spacer"></span>
    <div class="header__actions">
      <button class="search-trigger" type="button" data-search-open
              data-i18n-attr="aria-label:nav.searchAria"
              aria-label="{esc(T("nav.searchAria", lang))}">
        {icons["search"]}<span data-i18n="nav.search">{esc(T("nav.search", lang))}</span><kbd>Ctrl K</kbd>
      </button>
      {language_html}
      {appearance_html}
      {notify_slot}
      {auth_slot}
      {social_html}
      <button class="nav-toggle" type="button" data-nav-toggle data-i18n-attr="aria-label:a11y.menu"
              aria-label="{esc(T("a11y.menu", lang))}" aria-expanded="false">{icons["menu"]}</button>
    </div>
  </div>
</header>
<nav class="mobile-nav" data-mobile-nav aria-label="{esc(T("a11y.mobileNav", lang))}" data-i18n-attr="aria-label:a11y.mobileNav">{mobile_nav_html}</nav>

{announce_html}

<main id="main">
{content}
</main>

<footer class="site-footer">
  <div class="wrap site-footer__inner">
    <div class="site-footer__left">
      <div>© {year_text} {author}{footer_note}</div>
      {icp_block}
      {legal_links_html}
    </div>
    <div class="site-footer__right">{social_html}</div>
  </div>
</footer>

<button class="to-top" type="button" data-to-top data-i18n-attr="aria-label:a11y.toTop"
        aria-label="{esc(T("a11y.toTop", lang))}">{icons["up"]}</button>

<div class="search-overlay" data-search-overlay role="dialog" aria-modal="true"
     aria-label="{esc(T("search.title", lang))}" data-i18n-attr="aria-label:search.title">
  <div class="search-panel">
    <div class="search-panel__field">
      {icons["search"]}
      <input class="search-panel__input" type="search" data-search-input autocomplete="off" spellcheck="false"
             placeholder="{esc(T("search.placeholder", lang))}"
             data-i18n-attr="placeholder:search.placeholder">
      <span class="search-panel__esc">ESC</span>
    </div>
    <div class="search-results" data-search-results></div>
    <div class="search-hint">
      <span data-i18n="search.hintSelect">{esc(T("search.hintSelect", lang))}</span>
      <span data-i18n="search.hintOpen">{esc(T("search.hintOpen", lang))}</span>
      <span data-i18n="search.hintClose">{esc(T("search.hintClose", lang))}</span>
      <a class="search-hint__link" href="{root}shortcuts.html" data-i18n="search.tipKeys">{esc(T("search.tipKeys", lang))}</a>
    </div>
  </div>
</div>

<div class="toast" data-toast role="status" aria-live="polite"></div>

<!-- 闲置登出警告：只在已登录且接近 5 分钟未操作时由 idle.js 显示 -->
<div class="idle-warn" data-idle-warn data-show="false" aria-hidden="true" role="alertdialog">
  <div class="idle-warn__inner">
    <span class="idle-warn__text" data-idle-text></span>
    <button class="btn btn--sm" type="button" data-idle-continue
            data-i18n="idle.continue">{idle_continue}</button>
  </div>
</div>
{maintenance_html}
{scripts_html}
</body>
</html>"""
