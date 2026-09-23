# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Adapt assistant Markdown to the subset DingTalk AI cards render reliably.

DingTalk card Markdown renders headings, emphasis, lists, quotes, links,
images and fenced code blocks, but not GFM tables: table source appears to
users as raw ``|``-delimited lines. Convert every complete table block into
an aligned monospaced rendering inside a fenced code block so the tabular
structure stays readable. All other Markdown passes through unchanged.
"""

from __future__ import annotations

import re
import unicodedata

_SEPARATOR_CELL = re.compile(r"^:?-+:?$")
_FENCE = re.compile(r"^(`{3,}|~{3,})(.*)$")


def _display_width(text: str) -> int:
    """Monospace cell width; CJK wide/fullwidth glyphs occupy two columns."""
    return sum(
        2 if unicodedata.east_asian_width(char) in ("W", "F") else 1 for char in text
    )


def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - _display_width(text))


def _split_row(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    # A pipe is a delimiter only after an even run of backslashes; "\|" is a
    # literal pipe inside a cell, while "\\|" escapes the backslash instead.
    cells: list[str] = []
    start = 0
    backslashes = 0
    for index, char in enumerate(body):
        if char == "\\":
            backslashes += 1
            continue
        if char == "|" and backslashes % 2 == 0:
            cells.append(body[start:index])
            start = index + 1
        backslashes = 0
    cells.append(body[start:])
    if body.endswith("|") and cells[-1] == "":
        cells.pop()
    return [cell.strip().replace("\\|", "|") for cell in cells]


def _looks_like_row(line: str) -> bool:
    stripped = line.strip()
    return "|" in stripped and not _FENCE.match(stripped)


def _is_separator_row(line: str) -> bool:
    cells = _split_row(line)
    return bool(cells) and all(
        _SEPARATOR_CELL.match(cell.replace(" ", "")) for cell in cells
    )


def _render_table(rows: list[str]) -> str:
    header = _split_row(rows[0])
    body = [_split_row(line) for line in rows[2:]]
    columns = max([len(header), *(len(row) for row in body)] or [0])
    header += [""] * (columns - len(header))
    body = [row + [""] * (columns - len(row)) for row in body]
    widths = [
        max([_display_width(header[col]), *(_display_width(row[col]) for row in body)])
        for col in range(columns)
    ]

    def render_row(cells: list[str]) -> str:
        return " | ".join(
            _pad(cell, widths[col]) for col, cell in enumerate(cells)
        ).rstrip()

    divider = "-+-".join("-" * width for width in widths)
    lines = [render_row(header), divider, *(render_row(row) for row in body)]
    return "```\n" + "\n".join(lines) + "\n```"


def render_for_dingtalk(content: str) -> str:
    """Rewrite Markdown so DingTalk AI cards render it faithfully.

    Only complete table blocks (header, separator, optional body rows) are
    converted; a table still streaming without its separator row is left
    untouched until it completes. Tables inside fenced code blocks are
    already plain text and are preserved as-is.
    """
    if "|" not in content:
        return content
    lines = content.split("\n")
    out: list[str] = []
    fence_char: str | None = None
    fence_len = 0
    i = 0
    while i < len(lines):
        line = lines[i]
        fence = _FENCE.match(line.strip())
        if fence:
            marker = fence.group(1)
            if fence_char is None:
                fence_char, fence_len = marker[0], len(marker)
            elif (
                marker[0] == fence_char
                and len(marker) >= fence_len
                and not fence.group(2).strip()
            ):
                fence_char = None
            out.append(line)
            i += 1
            continue
        if (
            fence_char is None
            and i + 1 < len(lines)
            and _looks_like_row(line)
            and _is_separator_row(lines[i + 1])
        ):
            end = i + 2
            while end < len(lines) and _looks_like_row(lines[end]):
                end += 1
            out.append(_render_table(lines[i:end]))
            i = end
            continue
        out.append(line)
        i += 1
    return "\n".join(out)
