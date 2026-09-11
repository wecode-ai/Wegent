# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Markdown content helpers shared by the wiki bridge tools and preview.

Long-page policy (design §5.4): outline is always returned; content is
truncated at WIKI_PAGE_CONTENT_MAX_CHARS with a truncation flag, and the
section parameter makes overflow reachable without re-fetching full bodies.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$", re.MULTILINE)


@dataclass(frozen=True)
class OutlineItem:
    level: int
    title: str


def extract_outline(content: str) -> list[OutlineItem]:
    """Return ATX headings in document order."""
    items: list[OutlineItem] = []
    for match in _HEADING_RE.finditer(content):
        items.append(
            OutlineItem(level=len(match.group(1)), title=match.group(2).strip())
        )
    return items


def slice_section(content: str, section_title: str) -> str | None:
    """Return one section: from its heading to the next same-or-higher level.

    Child subsections are included. Matching is exact after whitespace
    normalization, case-insensitive; None when no heading matches.
    """
    wanted = section_title.strip().lower()
    if not wanted:
        return None
    headings = list(_HEADING_RE.finditer(content))
    for index, match in enumerate(headings):
        if match.group(2).strip().lower() != wanted:
            continue
        start = match.start()
        level = len(match.group(1))
        end = len(content)
        for follower in headings[index + 1 :]:
            if len(follower.group(1)) <= level:
                end = follower.start()
                break
        return content[start:end].strip()
    return None


def truncate_content(content: str, max_chars: int) -> tuple[str, bool, int]:
    """Truncate to max_chars, returning (body, truncated, total_chars)."""
    total = len(content)
    if total <= max_chars:
        return content, False, total
    return content[:max_chars], True, total
