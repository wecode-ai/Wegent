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
from app.services.task_fork_history import task_fork_history_resolver

_DEFAULT_STATUSES = (
    SubtaskStatus.COMPLETED,
    SubtaskStatus.CANCELLED,
    SubtaskStatus.FAILED,
)


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


def apply_checkpoint_limit(
    subtasks: list[Any],
    *,
    limit: int | None,
    from_latest_compaction: bool,
) -> list[Any]:
    """Apply ``limit`` without ever dropping the checkpoint subtask (index 0).

    When scoping from a checkpoint, the first subtask is the checkpoint chain and
    must always be returned; ``limit`` only bounds the turns after it. Otherwise
    this is the plain "most recent N subtasks" behaviour.
    """
    if not limit or limit <= 0:
        return subtasks
    if from_latest_compaction and subtasks:
        head, tail = subtasks[:1], subtasks[1:]
        return head if limit <= 1 else head + tail[-(limit - 1) :]
    return subtasks[-limit:]


def resolve_history_subtasks(
    *,
    db,
    task_id,
    user_id,
    before_message_id=None,
    limit=None,
    from_latest_compaction=False,
    statuses=None,
) -> list[Any]:
    """Single resolve -> status-filter -> checkpoint-scope -> limit pipeline.

    Used by both the HTTP history endpoint and the package-mode loader so fork,
    ``before_message_id``, ``limit``, and checkpoint semantics stay identical.
    """
    statuses = tuple(statuses) if statuses else _DEFAULT_STATUSES
    if limit is not None and limit <= 0:
        return []
    checkpoint = None
    if limit is not None and from_latest_compaction:
        checkpoint = _resolve_checkpoint(
            db, task_id, user_id, before_message_id, statuses
        )
        if checkpoint is not None and limit == 1:
            return [checkpoint]
    items = task_fork_history_resolver.resolve_for_task(
        db,
        task_id=task_id,
        user_id=user_id,
        before_message_id=before_message_id,
        limit=limit - 1 if checkpoint is not None else limit,
        statuses=statuses,
    )
    subtasks = [item.subtask for item in items if item.subtask.status in statuses]
    if checkpoint is not None:
        checkpoint_key = _history_key(checkpoint)
        return [checkpoint] + [
            subtask for subtask in subtasks if _history_key(subtask) > checkpoint_key
        ]
    # Only preserve subtasks[0] as inviolable when a checkpoint was actually
    # found; otherwise (uncompacted task) fall back to plain "most recent N",
    # or `limit` would wrongly pin the oldest turn instead of the checkpoint.
    scoped_to_checkpoint = False
    if from_latest_compaction:
        subtasks, checkpoint_index = scope_to_latest_checkpoint(subtasks)
        scoped_to_checkpoint = checkpoint_index is not None
    return apply_checkpoint_limit(
        subtasks, limit=limit, from_latest_compaction=scoped_to_checkpoint
    )


def _history_key(subtask: Any) -> tuple[Any, ...]:
    """Match the resolver's stable ordering, including repeated message ids."""
    return subtask.message_id, subtask.created_at, subtask.id


def _resolve_checkpoint(
    db: Any,
    task_id: int,
    user_id: int,
    before_message_id: int | None,
    statuses: tuple[SubtaskStatus, ...],
) -> Any | None:
    """Read the latest checkpoint across the same fork and status bounds."""
    checkpoints = task_fork_history_resolver.resolve_for_task(
        db,
        task_id=task_id,
        user_id=user_id,
        before_message_id=before_message_id,
        limit=1,
        statuses=statuses,
        summary_checkpoint_only=True,
    )
    return checkpoints[-1].subtask if checkpoints else None
