"""通用工具函数。

与 Node 版 ``src/lib/util.js`` 一一对应，行为（包括 HTML 转义方式、
ISO 时间格式、阅读时长估算）都刻意保持一致。
"""

from __future__ import annotations

import math
import re
from datetime import date as _date, datetime, timezone

__all__ = [
    "escape_html",
    "slugify",
    "parse_date",
    "format_date",
    "iso_date",
    "utc_string",
    "html_to_plain_text",
    "reading_time",
    "truncate",
    "by_date_desc",
    "root_prefix",
]

_WEEKDAYS_EN = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_MONTHS_EN = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)

_CJK_RE = re.compile(r"[\u4e00-\u9fa5]")
_ASCII_WORD_RE = re.compile(r"[A-Za-z0-9_]+")
_DATE_ONLY_RE = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})")
_NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")


def escape_html(value="") -> str:
    """HTML 转义，防止内容破坏页面结构。

    刻意手写而不用 ``html.escape``：后者把单引号转义成 ``&#x27;``，
    这里沿用 JS 版的 ``&#39;``，保证产物可逐字节对比。
    """
    text = str(value)
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def slugify(text="") -> str:
    """生成 URL 友好的 slug。中文保留，空格与特殊符号折叠为连字符。"""
    value = str(text).strip().lower()
    value = re.sub(r"[\s\u3000]+", "-", value)
    value = re.sub(r"[^\w\u4e00-\u9fa5-]+", "", value, flags=re.ASCII)
    value = re.sub(r"-{2,}", "-", value)
    value = re.sub(r"^-|-$", "", value)
    return value or "section"


def _local_tz():
    return datetime.now().astimezone().tzinfo


def parse_date(value):
    """把 front-matter 里的日期解析成带时区的 datetime。

    对齐 JS 的行为：``new Date('2026-10-12')`` 这类纯日期字符串按 UTC 解析，
    带时间的字符串按本地时区解析。
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=_local_tz())
    if isinstance(value, _date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)

    text = str(value).strip()
    if not text:
        return None

    matched = _DATE_ONLY_RE.fullmatch(text)
    if matched:
        try:
            return datetime(
                int(matched.group(1)), int(matched.group(2)), int(matched.group(3)),
                tzinfo=timezone.utc,
            )
        except ValueError:
            return None

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_local_tz())


def format_date(value) -> str:
    """把日期格式化为 2026 年 10 月 12 日"""
    parsed = parse_date(value)
    if parsed is None:
        return "" if value is None else str(value)
    local = parsed.astimezone()
    return f"{local.year} 年 {local.month} 月 {local.day} 日"


def iso_date(value) -> str:
    """ISO 8601（UTC，毫秒精度），等价于 JS 的 ``Date#toISOString``。"""
    parsed = parse_date(value)
    if parsed is None:
        return ""
    utc = parsed.astimezone(timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def utc_string(value) -> str:
    """RFC 1123 时间串，等价于 JS 的 ``Date#toUTCString``（英文缩写，不受 locale 影响）。"""
    parsed = parse_date(value)
    if parsed is None:
        return ""
    utc = parsed.astimezone(timezone.utc)
    return (
        f"{_WEEKDAYS_EN[utc.weekday()]}, {utc.day:02d} {_MONTHS_EN[utc.month - 1]} "
        f"{utc.year} {utc.hour:02d}:{utc.minute:02d}:{utc.second:02d} GMT"
    )


def html_to_plain_text(html="") -> str:
    """从 HTML 中抽取纯文本，用于摘要与搜索索引。"""
    text = str(html)
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    for entity, plain in (
        ("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
        ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"),
    ):
        text = text.replace(entity, plain)
    return re.sub(r"\s+", " ", text).strip()


def reading_time(text="") -> int:
    """估算中文为主的阅读时长（分钟）。"""
    cjk = len(_CJK_RE.findall(str(text)))
    words = len(_ASCII_WORD_RE.findall(str(text)))
    minutes = cjk / 400 + words / 220
    # JS 的 Math.round 是「四舍五入远离零」，Python 的 round 是银行家舍入
    return max(1, math.floor(minutes + 0.5))


def truncate(text="", max_length=120) -> str:
    value = str(text).strip()
    if len(value) <= max_length:
        return value
    return re.sub(r"[\s,，、。;；:：-]+$", "", value[:max_length]) + "…"


def by_date_desc(item):
    """排序键：按日期倒序（配合 ``reverse=True`` 使用）。"""
    parsed = parse_date(item.get("date") if isinstance(item, dict) else item)
    if parsed is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    return parsed


def root_prefix(depth: int) -> str:
    """页面所在的目录层级，用于计算相对路径前缀。"""
    return "" if depth == 0 else "../" * depth
