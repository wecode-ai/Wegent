# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base meta prompt formatter (Backend-only).

This module formats the knowledge base metadata prompt that is injected via Chat Shell's
`dynamic_context` mechanism as a **human message** (not system prompt).

Design goals:
- Keep this module PURE: it MUST NOT query the database.
- Callers (e.g. chat preprocessing) should assemble the KB meta list based on the
  current request's resolved KB IDs and priority rules, then call `format_kb_meta_prompt`.

All comments must be written in English.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Threshold above which short summaries are preferred over long summaries to
# reduce token usage when many KBs are included in the meta prompt.
SHORT_SUMMARY_THRESHOLD = 3


def select_kb_summary_text(summary_data: dict[str, Any], kb_count: int) -> str:
    """Select summary text based on KB count.

    - For 1-2 KBs: prefer long_summary.
    - For 3+ KBs: prefer short_summary to save tokens.

    Args:
        summary_data: The `spec.summary` object from a KnowledgeBase Kind.
        kb_count: Total KB count in the current meta list.

    Returns:
        Summary text or empty string.
    """

    use_short = kb_count >= SHORT_SUMMARY_THRESHOLD

    if use_short:
        summary_text = summary_data.get("short_summary") or summary_data.get(
            "long_summary"
        )
    else:
        summary_text = summary_data.get("long_summary") or summary_data.get(
            "short_summary"
        )

    return summary_text or ""


def format_kb_meta_prompt(kb_meta_list: list[dict[str, Any]]) -> str:
    """Format KB meta list into a dynamic_context prompt string.

    Expected item keys:
    - kb_id: int | str
    - kb_name: str
    - summary_text: optional str
    - topics: optional list[str]

    Args:
        kb_meta_list: Pre-assembled KB meta list.

    Returns:
        A single string for dynamic_context injection, or empty string.
    """

    if not kb_meta_list:
        return ""

    kb_lines: list[str] = []

    for kb_meta in kb_meta_list:
        kb_name = kb_meta.get("kb_name", "Unknown")
        kb_id = kb_meta.get("kb_id", "N/A")
        kb_lines.append(f"- KB Name: {kb_name}, KB ID: {kb_id}")

        summary_text = kb_meta.get("summary_text") or ""
        topics = kb_meta.get("topics") or []

        if summary_text:
            kb_lines.append(f"  - Summary: {summary_text}")
        if topics:
            kb_lines.append(f"  - Topics: {', '.join(topics)}")

    kb_list_str = "\n".join(kb_lines)

    return (
        "Available Knowledge Bases:\n"
        f"{kb_list_str}\n\n"
        "Note: This metadata is provided for intent routing (e.g., answering which KBs are selected). "
        "Use the knowledge_base_search tool to retrieve document evidence when needed."
    )
