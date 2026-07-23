# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Locate the latest summary-compaction checkpoint in a subtask stream.

The checkpoint is identified by an in-chain ``summary_compacted`` marker (the
event-level ``context_compactions`` is diagnostic only — its message id is a
LangChain runtime id not persisted in ``messages_chain``).
"""

from __future__ import annotations

from typing import Any

from app.models.subtask import SubtaskRole, SubtaskStatus


def subtask_has_summary_checkpoint(subtask: Any) -> bool:
    """True for a COMPLETED assistant subtask whose chain carries a summary marker."""
    if subtask.role != SubtaskRole.ASSISTANT:
        return False
    if subtask.status != SubtaskStatus.COMPLETED:
        return False
    result = subtask.result
    if not isinstance(result, dict):
        return False
    chain = result.get("messages_chain")
    if not isinstance(chain, list):
        return False
    return any(
        isinstance(m, dict)
        and isinstance(m.get("additional_kwargs"), dict)
        and m["additional_kwargs"].get("summary_compacted") is True
        for m in chain
    )


def scope_to_latest_checkpoint(subtasks: list[Any]) -> tuple[list[Any], int | None]:
    """Slice ``subtasks`` to start at the latest checkpoint subtask.

    Returns ``(sliced, checkpoint_index)``; ``(subtasks, None)`` when no
    checkpoint is present (caller falls back to full history).
    """
    latest: int | None = None
    for i, subtask in enumerate(subtasks):
        if subtask_has_summary_checkpoint(subtask):
            latest = i
    if latest is None:
        return subtasks, None
    return subtasks[latest:], latest
