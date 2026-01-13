# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Markdown heading remapping utilities.

This module provides a helper function to normalize ATX-style Markdown
headings by remapping their levels relative to the top-level heading
present in a document.

The main use case is to enforce a consistent top heading level across
multiple Markdown files, for example:
- Ensuring that the top-level heading becomes a second-level heading
- Shifting all other headings by the same offset
- Clamping heading levels into the range supported by Markdown (1–6)
"""

import re
from typing import Match

# Match ATX-style headings, e.g. "## Title"
_HEADING_RE = re.compile(
    r"^(?P<indent>\s*)(?P<hashes>#{1,6})(?P<space>\s+)(?P<text>.*)$",
    re.MULTILINE,
)


def remap_prompts_headings(md_text: str, target_top_level: int = 2) -> str:
    """
    Remap ATX-style Markdown headings based on the *top* (smallest-number) heading
    in the document.

    - Detect the smallest heading level in the document (e.g. 1 for "#", 3 for "###").
    - Map that smallest level to `target_top_level`.
    - Shift all other headings by the same offset.
    - Clamp heading levels to the range [1, 6].

    Example:
        Input headings: #, ##, ###
        Min level = 1, target_top_level = 3
        offset = 3 - 1 = +2
        Result: ###, ####, #####

    Parameters
    ----------
    md_text : str
        The Markdown source as a single string.
    target_top_level : int, optional
        The level that the *top* heading in the document should become.
        Default is 2.

    Returns
    -------
    str
        The Markdown text with remapped heading levels.
    """
    # Clamp target_top_level to [1, 6]
    target_top_level = max(1, min(target_top_level, 6))

    # First pass: detect all heading levels and find the minimal one
    levels = [len(m.group("hashes")) for m in _HEADING_RE.finditer(md_text)]
    if not levels:
        # No headings found; return the original text
        return md_text

    min_level = min(levels)
    offset = (
        target_top_level - min_level
    )  # Shift so that top (min) level becomes target_top_level

    def _replace(match: Match) -> str:
        indent = match.group("indent")
        hashes = match.group("hashes")
        space = match.group("space")
        text = match.group("text")

        old_level = len(hashes)
        new_level = max(1, min(old_level + offset, 6))
        return f"{indent}{'#' * new_level}{space}{text}"

    # Second pass: apply the remapped levels
    return _HEADING_RE.sub(_replace, md_text)
