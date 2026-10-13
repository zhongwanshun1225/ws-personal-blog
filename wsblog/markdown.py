"""Markdown 渲染层。

设计要点（与 Node 版一致）：

- 直接遍历 markdown-it-py 的 token 流生成 HTML，而不是渲染后再用正则修补；
- 代码高亮在【构建时】完成，页面不需要任何客户端高亮脚本，
  打开即见颜色，也没有 FOUC；
- 渲染过程中顺带收集标题，用于生成文章目录（TOC）。

数学公式与图表（V12）：

- ``$$…$$``（块级）与 ``$…$``（行内）在构建时被抽成占位符，渲染完再换成
  ``<div class="math-block" data-tex="…">`` / ``<span class="math-inline" data-tex="…">``；
  真正的排版由浏览器端 ``math.js`` 调 KaTeX 完成。
- ```` ```mermaid ```` 代码块渲染成 ``<div data-mermaid>``，源码放在 ``<pre>`` 里，
  由 ``math.js`` 调 Mermaid 画图。
- 两者都是**按需加载**：``render_markdown`` 会返回 ``has_math`` / ``has_mermaid``，
  构建器只给真的有公式或图表的页面注入 ``math.js`` 与对应库（KaTeX 273 KB、
  Mermaid 2.5 MB，不加载就是 0）。
- 公式抽取做了保护：围栏代码块与行内代码里的 ``$`` 不会被当成公式。
"""

from __future__ import annotations

import re

from markdown_it import MarkdownIt

from .highlight import LANG_LABELS, highlight_code
from .util import escape_html, slugify

__all__ = ["render_markdown"]

CALLOUT_LABELS = {
    "note": ("说明", "◆"),
    "tip": ("提示", "✦"),
    "important": ("重要", "❢"),
    "warning": ("注意", "▲"),
    "caution": ("警告", "■"),
}

_CALLOUT_RE = re.compile(
    r"^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?([\s\S]*)$",
    re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")
_EXTERNAL_RE = re.compile(r"^https?://", re.IGNORECASE)

# ---------- 公式抽取（V12） ----------
# 占位符用「私用区」字符包起来（U+E000 / U+E001）。
# ⚠️ 这里踩过一个坑：一开始用 \x00 做哨兵，结果 CommonMark 规范要求把 NUL
# 替换成 U+FFFD，解析后哨兵就变了形，替换永远匹配不上。私用区字符不会被改。
_SENT_L, _SENT_R = "\ue000", "\ue001"
_MATH_BLOCK_TOKEN = _SENT_L + "BM{index}" + _SENT_R
_MATH_INLINE_TOKEN = _SENT_L + "IM{index}" + _SENT_R
_SPAN_TOKEN = _SENT_L + "S{index}" + _SENT_R

_MASK_INLINE_CODE_RE = re.compile(r"(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)")
_FENCE_BLOCK_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|\Z)", re.MULTILINE)
_BLOCK_MATH_RE = re.compile(r"\$\$(?:\s*\n)?([\s\S]+?)\$\$")
# 行内公式：开 $ 后不能是空白、闭 $ 前不能是空白、闭 $ 后不能是数字 ——
# 这样「价格 $5 到 $9」这类文本不会被误判成公式。
_INLINE_MATH_RE = re.compile(r"(?<![\\$])\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)")


def _protect_spans(source: str) -> tuple[str, list[str]]:
    """把围栏代码块与行内代码临时挖走，返回（挖空后的文本, 原片段表）。"""
    stash: list[str] = []

    def _stash(match: re.Match) -> str:
        stash.append(match.group(0))
        return _SPAN_TOKEN.format(index=len(stash) - 1)

    # 先整段围栏（``` 之间的内容完全不参与公式识别），再行内代码
    text = _FENCE_BLOCK_RE.sub(_stash, source)
    text = _MASK_INLINE_CODE_RE.sub(_stash, text)
    return text, stash


def extract_math(source: str) -> tuple[str, dict[str, tuple[str, str]]]:
    """把公式换成占位符。

    返回（替换后的 Markdown 源码, ``{占位符: (tex, 类型)}``）。
    类型是 ``"block"`` 或 ``"inline"``。
    """
    text, stash = _protect_spans(source or "")
    found: dict[str, tuple[str, str]] = {}

    def _block(match: re.Match) -> str:
        token = _MATH_BLOCK_TOKEN.format(index=len(found))
        found[token] = (match.group(1).strip(), "block")
        return f"\n{token}\n"

    def _inline(match: re.Match) -> str:
        token = _MATH_INLINE_TOKEN.format(index=len(found))
        found[token] = (match.group(1).strip(), "inline")
        return token

    text = _BLOCK_MATH_RE.sub(_block, text)
    text = _INLINE_MATH_RE.sub(_inline, text)

    # 还原被挖走的代码片段
    for index, fragment in enumerate(stash):
        text = text.replace(_SPAN_TOKEN.format(index=index), fragment)
    return text, found


def _render_math(html: str, found: dict[str, tuple[str, str]]) -> str:
    """把占位符换成可被 math.js 渲染的容器。

    ``<p>\\x00BM0\\x00</p>`` 这种「块级公式独占一段」的情形会先被剥掉
    外层 ``<p>`` —— 否则 ``<div>`` 会嵌在 ``<p>`` 里，浏览器解析器会拆散结构。
    """
    if not found:
        return html

    for token, (tex, kind) in found.items():
        if kind == "block":
            html = re.sub(
                r"<p>\s*" + re.escape(token) + r"\s*</p>",
                lambda _m, k=token: k,
                html,
            )

    for token, (tex, kind) in found.items():
        payload = escape_html(tex)
        # 元素里同时放一份 LaTeX 源码：没有 JS（或被 CSP / 网络挡住 KaTeX）时，
        # 读者看到的是一行可辨认的公式源码，而不是一片空白。
        # KaTeX 渲染成功会整体替换内部内容，data-tex 才是它的输入。
        if kind == "block":
            markup = (
                '<div class="math-block" data-tex="' + payload + '" data-display="1">'
                + payload
                + "</div>"
            )
        else:
            markup = (
                '<span class="math-inline" data-tex="' + payload + '">' + payload + "</span>"
            )
        html = html.replace(token, markup)
    return html


def _make_parser() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": True, "breaks": False, "typographer": False})
    md.enable(["table", "strikethrough"])
    return md


class _Renderer:
    """把 markdown-it 的 token 流渲染成站点所需的 HTML 结构。"""

    def __init__(self, md: MarkdownIt) -> None:
        self.md = md
        self.toc: list[dict] = []
        self._used_ids: dict[str, int] = {}
        # V12：记录本页是否真的用到图表，构建器据此决定要不要注入 math.js
        self.has_mermaid = False

    # ---------- 块级 ----------

    def render_blocks(self, tokens) -> str:
        out: list[str] = []
        i = 0
        total = len(tokens)

        while i < total:
            token = tokens[i]
            ttype = token.type

            if ttype == "heading_open":
                inline = tokens[i + 1] if i + 1 < total else None
                out.append(self._heading(token, inline))
                i += 3
                continue

            if ttype == "paragraph_open":
                inline = tokens[i + 1] if i + 1 < total and tokens[i + 1].type == "inline" else None
                body = self.render_inline(inline)
                # 紧凑列表里的段落是隐藏的，不能额外包 <p>
                out.append(f"{body}\n" if token.hidden else f"<p>{body}</p>\n")
                i += 3
                continue

            if ttype == "inline":
                out.append(self.render_inline(token))
                i += 1
                continue

            if ttype in ("fence", "code_block"):
                out.append(self._code_block(token))
                i += 1
                continue

            if ttype == "blockquote_open":
                block, i = self._blockquote(tokens, i)
                out.append(block)
                continue

            if ttype == "bullet_list_open":
                out.append("<ul>\n")
            elif ttype == "bullet_list_close":
                out.append("</ul>\n")
            elif ttype == "ordered_list_open":
                start = token.attrGet("start")
                attr = f' start="{escape_html(start)}"' if start and str(start) != "1" else ""
                out.append(f"<ol{attr}>\n")
            elif ttype == "ordered_list_close":
                out.append("</ol>\n")
            elif ttype == "list_item_open":
                out.append("<li>")
            elif ttype == "list_item_close":
                out.append("</li>\n")
            elif ttype == "table_open":
                table, i = self._table(tokens, i)
                out.append(table)
                continue
            elif ttype == "hr":
                out.append("<hr>\n")
            elif ttype == "html_block":
                out.append(token.content)
            elif ttype in ("paragraph_close", "heading_close"):
                pass

            i += 1

        return "".join(out)

    def _unique_id(self, base: str) -> str:
        """同页重名标题自动加后缀，避免锚点冲突。"""
        if base in self._used_ids:
            self._used_ids[base] += 1
            return f"{base}-{self._used_ids[base]}"
        self._used_ids[base] = 0
        return base

    def _heading(self, token, inline) -> str:
        depth = int(token.tag[1])
        inner = self.render_inline(inline)
        plain = _TAG_RE.sub("", inner)
        anchor_id = self._unique_id(slugify(plain))

        if 2 <= depth <= 4:
            self.toc.append({"depth": depth, "text": plain, "id": anchor_id})
            anchor = f'<a class="heading-anchor" href="#{anchor_id}" aria-label="锚点链接">#</a>'
        else:
            anchor = ""

        return f'<h{depth} id="{anchor_id}">{inner}{anchor}</h{depth}>\n'

    def _code_block(self, token) -> str:
        info = str(token.info or "").strip()
        trimmed_lang = info.split()[0] if info else ""

        # ```mermaid —— 不生成高亮代码块，而是留一个容器等浏览器端画图。
        # 源码放在 <pre> 里（已转义），math.js 取 textContent 交给 mermaid.render。
        if trimmed_lang.lower() == "mermaid":
            self.has_mermaid = True
            return (
                '<div class="mermaid-block" data-mermaid>'
                '<div class="mermaid-block__bar">'
                '<span class="mermaid-block__label">Mermaid</span>'
                '<button class="mermaid-block__src-toggle" type="button" data-mermaid-toggle '
                'aria-expanded="false">查看源码</button>'
                "</div>"
                f'<pre class="mermaid-block__src" data-mermaid-src>{escape_html(token.content)}</pre>'
                '<div class="mermaid-block__out" data-mermaid-out aria-busy="true"></div>'
                "</div>"
            )

        code_html, used = highlight_code(token.content, trimmed_lang)
        label = (
            LANG_LABELS.get(used)
            or LANG_LABELS.get(trimmed_lang)
            or (trimmed_lang or "Text")
        )

        return "".join(
            [
                f'<div class="code-block" data-lang="{escape_html(used)}">',
                '<div class="code-block__bar">',
                '<span class="code-block__dots" aria-hidden="true"><i></i><i></i><i></i></span>',
                f'<span class="code-block__lang">{escape_html(label)}</span>',
                '<button class="code-block__copy" type="button" data-copy aria-label="复制代码">复制</button>',
                "</div>",
                f'<pre class="code-block__pre"><code class="hljs language-{escape_html(used)}">'
                f"{code_html}</code></pre>",
                "</div>",
            ]
        )

    def _blockquote(self, tokens, start: int) -> tuple[str, int]:
        # 找到配对的 blockquote_close，取出内部 token 区间
        end = start + 1
        depth = 0
        while end < len(tokens):
            if tokens[end].type == "blockquote_open":
                depth += 1
            elif tokens[end].type == "blockquote_close":
                if depth == 0:
                    break
                depth -= 1
            end += 1

        inner = list(tokens[start + 1 : end])
        kind, inner = self._detect_callout(inner)

        body = self.render_blocks(inner)
        if kind:
            label, icon = CALLOUT_LABELS[kind]
            return (
                f'<div class="callout callout--{kind}">'
                f'<div class="callout__title"><span class="callout__icon">{icon}</span>{label}</div>'
                f'<div class="callout__body">{body}</div>'
                "</div>"
            ), end + 1

        return f"<blockquote>{body}</blockquote>\n", end + 1

    def _detect_callout(self, inner: list) -> tuple[str | None, list]:
        """检测 GitHub 风格的提示块 ``> [!NOTE]``，命中则抹掉标记行。"""
        for index, token in enumerate(inner):
            if token.type == "inline":
                matched = _CALLOUT_RE.match(token.content)
                if not matched:
                    return None, inner
                kind = matched.group(1).lower()
                rest = matched.group(2).lstrip("\n")
                rebuilt = list(inner)
                rebuilt[index] = self._rebuild_inline(token, rest)
                return kind, rebuilt
            if token.type not in ("paragraph_open", "blockquote_open"):
                return None, inner
        return None, inner

    def _rebuild_inline(self, token, content: str):
        """用新的文本重建 inline token（children 需要重新解析）。"""
        parsed = self.md.parseInline(content)
        if parsed and parsed[0].type == "inline":
            return parsed[0]
        token.content = content
        token.children = []
        return token

    def _table(self, tokens, start: int) -> tuple[str, int]:
        out: list[str] = ['<div class="table-wrap"><table>']
        i = start + 1
        while i < len(tokens) and tokens[i].type != "table_close":
            token = tokens[i]
            ttype = token.type

            if ttype in ("thead_open", "tbody_open", "tr_open"):
                out.append(f"<{ttype[:-5]}>")
            elif ttype in ("thead_close", "tbody_close", "tr_close"):
                out.append(f"</{ttype[:-6]}>")
            elif ttype in ("th_open", "td_open"):
                tag = "th" if ttype == "th_open" else "td"
                style = token.attrGet("style")
                out.append(f'<{tag} style="{escape_html(style)}">' if style else f"<{tag}>")
            elif ttype in ("th_close", "td_close"):
                out.append("</th>" if ttype == "th_close" else "</td>")
            elif ttype == "inline":
                out.append(self.render_inline(token))

            i += 1

        out.append("</table></div>\n")
        return "".join(out), i + 1

    # ---------- 内联 ----------

    def render_inline(self, token) -> str:
        if token is None:
            return ""
        children = token.children or []
        out: list[str] = []
        link_stack: list[bool] = []

        for child in children:
            ttype = child.type

            if ttype in ("text", "text_special"):
                out.append(escape_html(child.content))
            elif ttype == "code_inline":
                out.append(f"<code>{escape_html(child.content)}</code>")
            elif ttype == "strong_open":
                out.append("<strong>")
            elif ttype == "strong_close":
                out.append("</strong>")
            elif ttype == "em_open":
                out.append("<em>")
            elif ttype == "em_close":
                out.append("</em>")
            elif ttype == "s_open":
                out.append("<del>")
            elif ttype == "s_close":
                out.append("</del>")
            elif ttype == "softbreak":
                out.append("\n")
            elif ttype == "hardbreak":
                out.append("<br>")
            elif ttype == "link_open":
                href = child.attrGet("href") or ""
                title = child.attrGet("title")
                is_external = bool(_EXTERNAL_RE.match(href))
                attrs = ' target="_blank" rel="noopener noreferrer"' if is_external else ""
                title_attr = f' title="{escape_html(title)}"' if title else ""
                out.append(f'<a href="{escape_html(href)}"{title_attr}{attrs}>')
                link_stack.append(is_external)
            elif ttype == "link_close":
                is_external = link_stack.pop() if link_stack else False
                if is_external:
                    out.append('<span class="ext-icon" aria-hidden="true">↗</span>')
                out.append("</a>")
            elif ttype == "image":
                src = child.attrGet("src") or ""
                alt = child.attrGet("alt") or ""
                title = child.attrGet("title")
                title_attr = f' title="{escape_html(title)}"' if title else ""
                out.append(
                    f'<img src="{escape_html(src)}" alt="{escape_html(alt)}"{title_attr}'
                    ' loading="lazy" decoding="async">'
                )
            elif ttype == "html_inline":
                out.append(child.content)
            elif child.content:
                out.append(escape_html(child.content))

        return "".join(out)


# ---------- 图片懒加载兜底（V19） ----------
# Markdown 语法里的图片已经在 render_inline 里带了 loading="lazy"，
# 但正文里直接写的原始 HTML（<img src=…>）会原样透传 —— 这类图数量不定、
# 又常在长文深处，不补属性就是首屏带宽的纯损失。这里做一次统一的兜底。
_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_IMG_HAS_LOADING_RE = re.compile(r"\bloading\s*=", re.IGNORECASE)
_IMG_HAS_DECODING_RE = re.compile(r"\bdecoding\s*=", re.IGNORECASE)


def _ensure_lazy_images(html: str) -> str:
    """给还没有 ``loading`` 的 ``<img>`` 补上 lazy / async。"""

    def patch(match: re.Match) -> str:
        tag = match.group(0)
        extra = ""
        if not _IMG_HAS_LOADING_RE.search(tag):
            extra += ' loading="lazy"'
        if not _IMG_HAS_DECODING_RE.search(tag):
            extra += ' decoding="async"'
        if not extra:
            return tag
        return tag[:-1].rstrip() + extra + ">"

    return _IMG_TAG_RE.sub(patch, html)


def render_markdown(markdown: str = "") -> dict:
    """渲染 Markdown，返回 ``{"html", "toc", "has_math", "has_mermaid"}``。

    ``has_math`` / ``has_mermaid`` 供构建器做按需加载 —— 没有公式与图表的页面
    不会去下载 KaTeX（273 KB）与 Mermaid（2.5 MB）。
    """
    source, math_found = extract_math(str(markdown or ""))
    md = _make_parser()
    renderer = _Renderer(md)
    tokens = md.parse(source)
    html = renderer.render_blocks(tokens)
    html = _render_math(html, math_found)
    html = _ensure_lazy_images(html)
    return {
        "html": html,
        "toc": renderer.toc,
        "has_math": bool(math_found),
        "has_mermaid": renderer.has_mermaid,
    }
