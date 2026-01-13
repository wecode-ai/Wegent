# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Markdown utilities.

This module provides helper functions for processing Markdown content,
including heading level remapping.
"""

import re
from typing import Match

# Match ATX-style headings, e.g. "## Title"
_HEADING_RE = re.compile(
    r"^(?P<indent>\s*)(?P<hashes>#{1,6})(?P<space>\s+)(?P<text>.*)$",
    re.MULTILINE,
)

# Valid heading level range
_MIN_HEADING_LEVEL = 1
_MAX_HEADING_LEVEL = 6


def remap_markdown_headings(md_text: str, target_top_level: int = 2) -> str:
    """Remap ATX-style Markdown headings based on the top heading in the document.

    This function normalizes heading levels by:
    1. Detecting the smallest (top-level) heading in the document
    2. Mapping that level to the specified target level
    3. Shifting all other headings by the same offset
    4. Clamping all levels to the valid range [1, 6]

    The main use case is to enforce consistent heading hierarchy when combining
    multiple Markdown documents, ensuring proper nesting.

    Args:
        md_text: The Markdown source as a single string.
        target_top_level: The level that the top heading should become.
            Defaults to 2 (useful when embedding content under a main heading).
            Will be clamped to [1, 6] if out of range.

    Returns:
        The Markdown text with remapped heading levels.

    Examples:
        >>> text = "# Main\\n## Sub\\n### Deep"
        >>> remap_markdown_headings(text, target_top_level=2)
        '## Main\\n### Sub\\n#### Deep'

        >>> text = "### Already Deep\\n#### Even Deeper"
        >>> remap_markdown_headings(text, target_top_level=1)
        '# Already Deep\\n## Even Deeper'
    """
    # Clamp target_top_level to valid range
    target_top_level = max(
        _MIN_HEADING_LEVEL, min(target_top_level, _MAX_HEADING_LEVEL)
    )

    # First pass: detect all heading levels and find the minimum
    levels = [len(m.group("hashes")) for m in _HEADING_RE.finditer(md_text)]
    if not levels:
        # No headings found; return the original text
        return md_text

    min_level = min(levels)
    offset = target_top_level - min_level

    def _replace(match: Match[str]) -> str:
        indent = match.group("indent")
        hashes = match.group("hashes")
        space = match.group("space")
        text = match.group("text")

        old_level = len(hashes)
        new_level = max(_MIN_HEADING_LEVEL, min(old_level + offset, _MAX_HEADING_LEVEL))
        return f"{indent}{'#' * new_level}{space}{text}"

    # Second pass: apply the remapped levels
    return _HEADING_RE.sub(_replace, md_text)
