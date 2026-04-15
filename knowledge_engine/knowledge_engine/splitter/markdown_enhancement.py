# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import re
from typing import Iterable

from llama_index.core.schema import TextNode

MIN_INFORMATIVE_CHARACTERS = 24
HEADING_LINE_PATTERN = re.compile(r"^\s{0,3}#{1,6}\s+.+$", re.MULTILINE)
MARKDOWN_SYMBOL_PATTERN = re.compile(r"[#>*`\-\[\]\(\)_~]")


def _plain_text_length(text: str) -> int:
    without_headings = HEADING_LINE_PATTERN.sub("", text)
    normalized = MARKDOWN_SYMBOL_PATTERN.sub(" ", without_headings)
    return len(" ".join(normalized.split()))


def _is_weak_markdown_section(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    if HEADING_LINE_PATTERN.fullmatch(stripped):
        return True
    return _plain_text_length(stripped) < MIN_INFORMATIVE_CHARACTERS


def _merge_text(prefix: str, body: str) -> str:
    prefix = prefix.strip()
    body = body.strip()
    if not prefix:
        return body
    if not body:
        return prefix
    return f"{prefix}\n\n{body}"


def enhance_markdown_nodes(nodes: Iterable[TextNode]) -> list[TextNode]:
    """Merge heading-only or low-information markdown sections into the next node."""
    enhanced_nodes: list[TextNode] = []
    pending_prefix = ""
    pending_node: TextNode | None = None

    for node in nodes:
        node_text = getattr(node, "text", "") or ""
        if _is_weak_markdown_section(node_text):
            pending_prefix = _merge_text(pending_prefix, node_text)
            pending_node = node
            continue

        if pending_prefix:
            merged_text = _merge_text(pending_prefix, node_text)
            enhanced_nodes.append(node.model_copy(update={"text": merged_text}))
        else:
            enhanced_nodes.append(node)
        pending_prefix = ""
        pending_node = None

    if pending_prefix and pending_node is not None:
        enhanced_nodes.append(pending_node.model_copy(update={"text": pending_prefix}))

    return enhanced_nodes
