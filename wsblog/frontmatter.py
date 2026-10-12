"""极简 YAML front-matter 解析器。

只支持博客场景够用的子集，避免引入额外依赖：

    ---
    title: 我的文章
    date: 2026-10-12
    tags: [JavaScript, 性能]
    cover: /images/cover.png
    draft: false
    ---

数组也支持多行写法：

    tags:
      - JavaScript
      - 性能
"""

from __future__ import annotations

import re

__all__ = ["parse_yaml_lite", "parse_frontmatter"]

_LIST_ITEM_RE = re.compile(r"^\s*-\s+(.*)$")
_KEY_VALUE_RE = re.compile(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$")
_NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")
_FRONTMATTER_RE = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?")


def _strip_quotes(value: str) -> str:
    text = value.strip()
    if len(text) > 1 and (
        (text.startswith('"') and text.endswith('"'))
        or (text.startswith("'") and text.endswith("'"))
    ):
        return text[1:-1]
    return text


def _coerce(value: str):
    text = _strip_quotes(value)
    lowered = text.lower()
    if lowered in ("true", "yes"):
        return True
    if lowered in ("false", "no"):
        return False
    if lowered == "null":
        return None
    if _NUMBER_RE.match(text):
        return float(text) if "." in text else int(text)
    return text


def _parse_inline_array(value: str) -> list:
    inner = value[1:-1].strip()
    if not inner:
        return []
    return [item for item in (_coerce(part) for part in inner.split(",")) if item != ""]


def parse_yaml_lite(source: str = "") -> dict:
    """解析 front-matter 的键值内容。"""
    data: dict = {}
    current_key = None

    for raw_line in source.split("\n"):
        line = re.sub(r"\s+$", "", raw_line.replace("\r", ""))
        if not line.strip() or re.match(r"^\s*#", line):
            continue

        list_item = _LIST_ITEM_RE.match(line)
        if list_item and current_key:
            if not isinstance(data.get(current_key), list):
                data[current_key] = []
            data[current_key].append(_coerce(list_item.group(1)))
            continue

        kv = _KEY_VALUE_RE.match(line)
        if not kv:
            continue

        key, value = kv.group(1), kv.group(2)
        current_key = key

        if value == "":
            # 可能是多行数组的开始，也可能只是空值
            data[key] = []
        elif value.startswith("[") and value.endswith("]"):
            data[key] = _parse_inline_array(value)
        else:
            data[key] = _coerce(value)

    return data


def parse_frontmatter(raw: str = "") -> tuple[dict, str]:
    """拆分 front-matter 与正文，返回 ``(data, body)``。"""
    normalized = raw.lstrip("\ufeff")
    matched = _FRONTMATTER_RE.match(normalized)
    if not matched:
        return {}, normalized
    return parse_yaml_lite(matched.group(1)), normalized[matched.end():]
