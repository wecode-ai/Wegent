# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Markdown utilities.
This module provides helper functions for processing Markdown content,
including heading level remapping.
"""

from typing import Optional, Tuple

_MIN_HEADING_LEVEL = 1
_MAX_HEADING_LEVEL = 6


def _heading_info(line: str) -> Optional[Tuple[int, int]]:
    """If the line is an ATX-style heading, return (indent_len, level); otherwise None."""
    n = len(line)
    if n == 0:
        return None

    # 1. Count leading whitespace as indent
    i = 0
    while i < n and line[i] in (" ", "\t"):
        i += 1
    indent_len = i

    # 2. Count consecutive '#' characters (heading hashes)
    hash_start = i
    while i < n and line[i] == "#":
        i += 1
    level = i - hash_start

    # Heading level must be in the valid range
    if level < _MIN_HEADING_LEVEL or level > _MAX_HEADING_LEVEL:
        return None

    # 3. Next character must be at least one whitespace to be a valid ATX heading
    if i >= n or line[i] not in (" ", "\t"):
        return None

    return indent_len, level


def remap_markdown_headings(md_text: str, target_top_level: int = 1) -> str:
    """Remap ATX-style Markdown headings based on the top heading in the document."""
    # Clamp the target level to the valid range
    target_top_level = max(
        _MIN_HEADING_LEVEL, min(target_top_level, _MAX_HEADING_LEVEL)
    )

    # Preserve line endings so output format stays identical
    lines = md_text.splitlines(keepends=True)

    # First pass: find the minimum heading level in the document
    min_level: Optional[int] = None
    for line in lines:
        info = _heading_info(line.rstrip("\n"))
        if info is None:
            continue
        _, level = info
        if min_level is None or level < min_level:
            min_level = level

    # No headings found; return original text
    if min_level is None:
        return md_text

    offset = target_top_level - min_level

    # Second pass: rebuild lines with remapped heading levels
    out: list[str] = []
    for line in lines:
        # Strip newline for parsing, but remember it to preserve exactly
        if line.endswith("\n"):
            content = line[:-1]
            newline = "\n"
        else:
            content = line
            newline = ""

        info = _heading_info(content)
        if info is None:
            out.append(line)
            continue

        indent_len, old_level = info
        new_level = max(
            _MIN_HEADING_LEVEL,
            min(old_level + offset, _MAX_HEADING_LEVEL),
        )

        # Slice the original line to preserve original spaces and text
        indent = content[:indent_len]
        hashes_and_rest = content[indent_len:]
        # The first old_level characters of hashes_and_rest are '#'
        rest = hashes_and_rest[
            old_level:
        ]  # includes original whitespace and heading text
        new_line = f"{indent}{'#' * new_level}{rest}{newline}"
        out.append(new_line)

    return "".join(out)
