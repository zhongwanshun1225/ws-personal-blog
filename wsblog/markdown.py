"""Markdown 渲染层。

设计要点（与 Node 版一致）：

- 直接遍历 markdown-it-py 的 token 流生成 HTML，而不是渲染后再用正则修补；
- 代码高亮在【构建时】完成，页面不需要任何客户端高亮脚本，
  打开即见颜色，也没有 FOUC；
- 渲染过程中顺带收集标题，用于生成文章目录（TOC）。
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


def render_markdown(markdown: str = "") -> dict:
    """渲染 Markdown，返回 ``{"html": ..., "toc": [...]}``。"""
    md = _make_parser()
    renderer = _Renderer(md)
    tokens = md.parse(str(markdown or ""))
    html = renderer.render_blocks(tokens)
    return {"html": html, "toc": renderer.toc}
