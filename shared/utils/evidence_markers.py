"""Rewrite evidence markers in ordinary Markdown text, never protected syntax."""

import re
from collections.abc import Callable

# Whole code spans, fences, links/images and HTML are protected before rewriting.
_PROTECTED = re.compile(
    r"(?m)^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$"
    r"|(`+)[\s\S]*?\2"
    r"|(?<!\[)!?\[(?!\[)[^\n]*?\]\([^\n]*?\)"
    r"|(?<!\[)!?\[(?!\[)[^\n]*?\]\[[^\n]*?\]"
    r"|<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?</\3\s*>"
    r"|<[^>]*>"
)
_MARKER = re.compile(r"\[\[(evidence|citation):([^\]\n]+)\]\]")


def rewrite_markers(text: str, bind: Callable[[str], str]) -> str:
    def rewrite(part: str) -> str:
        return _MARKER.sub(
            lambda m: bind(m[2]) if m[1] == "evidence" else "[[evidence-unavailable]]",
            part,
        )

    parts: list[str] = []
    start = 0
    for match in _PROTECTED.finditer(text):
        parts.extend((rewrite(text[start : match.start()]), match[0]))
        start = match.end()
    parts.append(rewrite(text[start:]))
    return "".join(parts)
