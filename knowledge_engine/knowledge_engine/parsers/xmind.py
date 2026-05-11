# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""XMind file parser: converts .xmind ZIP archives to Markdown text."""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any


def _topic_to_markdown(topic: dict[str, Any], depth: int = 0) -> list[str]:
    """Recursively convert a topic node to Markdown lines.

    XMind topics represent mind-map nodes (central topic + branches), not
    document sections.  They are rendered as nested list items so that the
    sheet title (# heading) remains the only heading-level element.

    - depth 0 → top-level list item: ``- title``
    - depth >= 1 → indented list item: ``  - title`` (2 spaces per level)
    """
    lines: list[str] = []
    title = topic.get("title", "").strip()
    if not title:
        return lines

    indent = "  " * depth
    lines.append(f"{indent}- {title}")

    children_container = topic.get("children", {})
    attached = children_container.get("attached", []) if children_container else []
    for child in attached:
        lines.extend(_topic_to_markdown(child, depth + 1))

    return lines


def _sheet_to_markdown(sheet: dict[str, Any]) -> list[str]:
    """Convert a single XMind sheet to Markdown lines."""
    lines: list[str] = []
    sheet_title = sheet.get("title", "").strip()
    if sheet_title:
        lines.append(f"# {sheet_title}")

    root_topic = sheet.get("rootTopic")
    if root_topic:
        lines.extend(_topic_to_markdown(root_topic, depth=0))

    return lines


def parse_xmind_to_markdown(binary_data: bytes) -> str:
    """Parse an .xmind binary archive and return its content as Markdown text.

    XMind files are ZIP archives containing a ``content.json`` file that
    describes the mind-map structure.  This function extracts that JSON,
    walks the topic tree, and produces a Markdown representation suitable
    for downstream text chunking and indexing.

    Args:
        binary_data: Raw bytes of the .xmind file.

    Returns:
        A Markdown string representing all sheets and topics in the file.

    Raises:
        ValueError: If the archive does not contain a ``content.json`` entry.
    """
    with zipfile.ZipFile(io.BytesIO(binary_data)) as zf:
        if "content.json" not in zf.namelist():
            raise ValueError("Invalid .xmind archive: missing content.json")
        content_bytes = zf.read("content.json")

    sheets: list[dict[str, Any]] = json.loads(content_bytes)

    all_lines: list[str] = []
    for sheet in sheets:
        sheet_lines = _sheet_to_markdown(sheet)
        if sheet_lines:
            all_lines.extend(sheet_lines)
            all_lines.append("")  # blank line between sheets

    return "\n".join(all_lines).strip()
