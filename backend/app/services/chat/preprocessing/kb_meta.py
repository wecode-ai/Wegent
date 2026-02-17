# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base meta prompt builder (Backend-only).

This module builds the knowledge base meta prompt that used to be generated in
`chat_shell.history.loader` (package-mode helper).

Design goals:
- Backend is the single source of truth for KB meta prompt generation.
- Avoid reverse dependency: Backend MUST NOT import chat_shell.
- The generated prompt is intended to be injected via Chat Shell's
  `dynamic_context` mechanism as a **human message** (not system prompt) to
  improve prompt caching.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def _get_summary_text(summary_data: dict[str, Any], kb_count: int) -> str:
    """Return a summary text according to KB count.

    - For 1-2 KBs: use long_summary.
    - For 3+ KBs: use short_summary to save tokens.
    """

    use_short = kb_count >= 3

    if use_short:
        summary_text = summary_data.get("short_summary") or summary_data.get(
            "long_summary"
        )
    else:
        summary_text = summary_data.get("long_summary") or summary_data.get(
            "short_summary"
        )

    return summary_text or ""


def get_knowledge_base_meta_for_task(db: Session, task_id: int) -> list[dict[str, Any]]:
    """Get ordered KB meta list for a task.

    Returns items containing:
    - kb_id: Kind.id
    - kb_name: display name (spec.name) fallback to context name
    - kb_kind: Kind object (for summary/topics extraction) or None

    Order is preserved by first occurrence in historical contexts.
    """

    from app.models.subtask import Subtask
    from app.models.subtask_context import ContextType, SubtaskContext
    from app.services.knowledge.task_knowledge_base_service import (
        task_knowledge_base_service,
    )

    # Get all subtask IDs for this task.
    subtask_ids = [
        row[0] for row in db.query(Subtask.id).filter(Subtask.task_id == task_id).all()
    ]

    if not subtask_ids:
        return []

    contexts = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.subtask_id.in_(subtask_ids),
            SubtaskContext.context_type == ContextType.KNOWLEDGE_BASE.value,
        )
        .all()
    )

    kb_ids: list[int] = []
    seen_kb_ids: set[int] = set()
    kb_name_map: dict[int, str] = {}

    for ctx in contexts:
        kb_id = ctx.knowledge_id
        if kb_id and kb_id not in seen_kb_ids:
            seen_kb_ids.add(kb_id)
            kb_ids.append(kb_id)
            kb_name_map[kb_id] = ctx.name or "Unknown"

    if not kb_ids:
        return []

    # Batch fetch KB Kind objects (avoid N+1).
    kb_map = task_knowledge_base_service.get_knowledge_bases_by_ids(db, kb_ids)

    meta_list: list[dict[str, Any]] = []
    for kb_id in kb_ids:
        kb_kind = kb_map.get(kb_id)
        if kb_kind:
            kb_spec = kb_kind.json.get("spec", {}) if kb_kind.json else {}
            meta_list.append(
                {
                    "kb_id": kb_id,
                    "kb_name": kb_spec.get("name", kb_name_map.get(kb_id, "Unknown")),
                    "kb_kind": kb_kind,
                }
            )
        else:
            meta_list.append(
                {
                    "kb_id": kb_id,
                    "kb_name": kb_name_map.get(kb_id, "Unknown"),
                    "kb_kind": None,
                }
            )

    return meta_list


def build_kb_meta_prompt_for_task(db: Session, task_id: int) -> str:
    """Build KB meta prompt string for the given task.

    The output is meant for **dynamic_context injection** (human message).
    """

    kb_meta_list = get_knowledge_base_meta_for_task(db, task_id)
    if not kb_meta_list:
        return ""

    kb_count = len(kb_meta_list)
    kb_lines: list[str] = []

    for kb_meta in kb_meta_list:
        kb_name = kb_meta.get("kb_name", "Unknown")
        kb_id = kb_meta.get("kb_id", "N/A")
        kb_kind = kb_meta.get("kb_kind")

        kb_lines.append(f"- KB Name: {kb_name}, KB ID: {kb_id}")

        if not kb_kind:
            continue

        try:
            kb_spec = kb_kind.json.get("spec", {}) if kb_kind.json else {}
            summary_data = kb_spec.get("summary", {})

            if (
                kb_spec.get("summaryEnabled")
                and summary_data.get("status") == "completed"
            ):
                summary_text = _get_summary_text(summary_data, kb_count)
                topics = summary_data.get("topics", [])

                if summary_text:
                    kb_lines.append(f"  - Summary: {summary_text}")
                if topics:
                    kb_lines.append(f"  - Topics: {', '.join(topics)}")
        except Exception as e:
            logger.warning(
                "[kb_meta] Failed to extract summary for KB %s: %s",
                kb_id,
                e,
                exc_info=True,
            )

    kb_list_str = "\n".join(kb_lines)

    return (
        "Available Knowledge Bases (from conversation context):\n"
        f"{kb_list_str}\n\n"
        "Note: The knowledge base content has been pre-filled from history. "
        "If the provided information is insufficient, you can use the knowledge_base_search "
        "tool to retrieve more relevant content."
    )
