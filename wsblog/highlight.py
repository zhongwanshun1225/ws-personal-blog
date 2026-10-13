"""代码高亮。

用 Pygments 做词法分析，但输出沿用 highlight.js 的 class 体系
（``hljs-keyword`` / ``hljs-string`` …）。这样样式表里的深色高亮主题
可以整段复用，无需为换语言而改一行 CSS。
"""

from __future__ import annotations

from pygments.lexers import get_lexer_by_name, guess_lexer
from pygments.token import (
    Comment,
    Error,
    Generic,
    Keyword,
    Literal,
    Name,
    Number,
    String,
)
from pygments.util import ClassNotFound

from .util import escape_html

__all__ = ["highlight_code", "LANG_LABELS"]

# 代码块右上角的语言展示名（沿用 highlight.js 的习惯写法）
LANG_LABELS = {
    "js": "JavaScript",
    "javascript": "JavaScript",
    "ts": "TypeScript",
    "typescript": "TypeScript",
    "jsx": "JSX",
    "tsx": "TSX",
    "py": "Python",
    "python": "Python",
    "bash": "Bash",
    "sh": "Shell",
    "shell": "Shell",
    "zsh": "Zsh",
    "powershell": "PowerShell",
    "json": "JSON",
    "yaml": "YAML",
    "yml": "YAML",
    "toml": "TOML",
    "ini": "INI",
    "css": "CSS",
    "scss": "SCSS",
    "html": "HTML",
    "xml": "XML",
    "md": "Markdown",
    "markdown": "Markdown",
    "sql": "SQL",
    "go": "Go",
    "rust": "Rust",
    "java": "Java",
    "kotlin": "Kotlin",
    "swift": "Swift",
    "c": "C",
    "cpp": "C++",
    "csharp": "C#",
    "php": "PHP",
    "ruby": "Ruby",
    "dockerfile": "Dockerfile",
    "nginx": "Nginx",
    "diff": "Diff",
    "plaintext": "Text",
    "text": "Text",
    "textfile": "Text",
}

# Pygments 未收录、但写博客常见的别名兜底
_ALIASES = {
    "shell": "bash",
    "zsh": "bash",
    "ps": "powershell",
    "ps1": "powershell",
    "c#": "csharp",
    "c++": "cpp",
    "textfile": "text",
}


def _hljs_class(token_type) -> str | None:
    """把 Pygments 的 token 类型映射到 highlight.js 的 class 名。

    返回 ``None`` 表示不包裹 ``<span>``（运算符、标点、空白等）。
    """
    if token_type in Comment:
        return "hljs-comment"
    if token_type in Keyword.Type:
        return "hljs-type"
    if token_type in Keyword.Constant:
        return "hljs-literal"
    if token_type in Keyword:
        return "hljs-keyword"
    if token_type in String.Regex:
        return "hljs-regexp"
    if token_type in String:
        return "hljs-string"
    if token_type in Number:
        return "hljs-number"
    if token_type in Name.Function:
        return "hljs-title function_"
    if token_type in Name.Class:
        return "hljs-title class_"
    if token_type in Name.Builtin:
        return "hljs-built_in"
    if token_type in Name.Tag:
        return "hljs-tag"
    if token_type in Name.Attribute:
        return "hljs-attr"
    if token_type in (Name.Variable, Name.Constant):
        return "hljs-variable"
    if token_type in Name.Decorator:
        return "hljs-meta"
    if token_type in Name:
        return "hljs-title"
    if token_type in Literal:
        return "hljs-literal"
    if token_type in Generic.Inserted:
        return "hljs-addition"
    if token_type in Generic.Deleted:
        return "hljs-deletion"
    if token_type in Generic.Heading or token_type in Generic.Subheading:
        return "hljs-section"
    if token_type in Generic.Emph:
        return "hljs-emphasis"
    if token_type in Generic.Strong:
        return "hljs-strong"
    if token_type in Error:
        return "hljs-deletion"
    return None


def _render_token(token_type, value: str) -> str:
    escaped = escape_html(value)
    css_class = _hljs_class(token_type)
    # 纯空白不包裹，保持 HTML 体积与可读性
    if css_class is None or not value.strip():
        return escaped
    return f'<span class="{css_class}">{escaped}</span>'


def _resolve_lexer(lang_key: str):
    """把语言名解析成 lexer，找不到就返回 None。"""
    if not lang_key:
        return None
    candidates = [lang_key]
    alias = _ALIASES.get(lang_key)
    if alias:
        candidates.append(alias)
    for name in candidates:
        try:
            return get_lexer_by_name(name)
        except ClassNotFound:
            continue
    return None


def highlight_code(code: str, lang: str = "") -> tuple[str, str]:
    """高亮代码，返回 ``(html, 实际使用的语言标识)``。"""
    raw = str(code if code is not None else "")
    key = str(lang or "").strip().lower()

    lexer = _resolve_lexer(key)
    used = key

    if lexer is None:
        # 语言未指定或未识别：交给 Pygments 猜，猜不出就退化为纯文本
        try:
            lexer = guess_lexer(raw)
            aliases = getattr(lexer, "aliases", None)
            if aliases:
                used = aliases[0]
        except Exception:  # noqa: BLE001 —— 内容太短等情况下 Pygments 会抛错
            return escape_html(raw), key or "plaintext"

    try:
        parts = [_render_token(token_type, value) for token_type, value in lexer.get_tokens(raw)]
    except Exception:  # noqa: BLE001
        return escape_html(raw), key or "plaintext"

    return "".join(parts), used or key or "plaintext"
