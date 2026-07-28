# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared subtask-history retrieval for AI backtracking.

Single source of truth for "list the session's subtasks" and "read one subtask's
raw record", used by BOTH the internal HTTP endpoints and chat_shell package mode
(direct import) — so the query, scoping, DELETE filtering and preview logic are
never implemented twice. Reads the raw record (``result.blocks`` / ``prompt``),
deliberately un-compaction-scoped: backtracking recovers detail that compaction
summarized away.
"""

from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.stores.tasks import subtask_store

PREVIEW_CHARS = 200


def subtask_primary_text(subtask: Subtask) -> str:
    """Un-compacted plain text of a subtask, for preview and size."""
    if subtask.role == SubtaskRole.USER:
        return subtask.prompt or ""
    result = subtask.result if isinstance(subtask.result, dict) else {}
    value = result.get("value")
    return value if isinstance(value, str) else ""


def list_subtask_summaries(
    db: Session, *, task_id: int, user_id: int
) -> list[dict[str, Any]]:
    """Summaries for every non-deleted subtask of the task's session."""
    subtasks = subtask_store.list_new_messages_since(
        db, task_id=task_id, owner_user_id=user_id
    )
    summaries: list[dict[str, Any]] = []
    for st in subtasks:
        if st.status == SubtaskStatus.DELETE:
            continue
        text = subtask_primary_text(st)
        summaries.append(
            {
                "id": st.id,
                "role": st.role.value.lower(),
                "status": st.status.value,
                "char_count": len(text),
                "preview": text[:PREVIEW_CHARS],
            }
        )
    return summaries


def read_subtask_record(
    db: Session, *, task_id: int, subtask_id: int, user_id: int
) -> Optional[dict[str, Any]]:
    """One subtask's raw record, scoped to the task's session.

    Returns ``None`` when the subtask is missing, belongs to another task, or has
    been deleted — callers surface that as a 404 / not-available.
    """
    subtask = subtask_store.get_by_id(db, subtask_id=subtask_id, owner_user_id=user_id)
    # Owner filter alone is not enough: a same-user subtask in a different task
    # must not be readable through this session. Deleted subtasks are excluded to
    # match the listing.
    if (
        subtask is None
        or subtask.task_id != task_id
        or subtask.status == SubtaskStatus.DELETE
    ):
        return None

    role = subtask.role.value.lower()
    status = subtask.status.value
    if subtask.role == SubtaskRole.USER:
        return {
            "id": subtask.id,
            "role": role,
            "status": status,
            "prompt": subtask.prompt or "",
        }
    result = subtask.result if isinstance(subtask.result, dict) else {}
    return {
        "id": subtask.id,
        "role": role,
        "status": status,
        "blocks": result.get("blocks"),
        "messages_chain": result.get("messages_chain"),
        "value": result.get("value"),
    }
