# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fetch history subtask summaries and raw records for AI backtracking.

Mirrors the loader's mode switch: HTTP mode calls the backend internal endpoints
(``/chat/history/{session_id}/subtasks[/{id}]``) via ``RemoteHistoryStore``;
package mode reads the database directly. Both enforce the same session (task)
scoping as the endpoint, so the model can never read another conversation.

Reads the raw record (``result.blocks`` / ``prompt``), deliberately bypassing the
compaction-scoped history loader — the point of backtracking is to recover detail
that compaction summarized away.
"""

from __future__ import annotations

import asyncio
from typing import Any

from chat_shell.history.loader import _get_remote_history_store, _is_http_mode


class SubtaskRecordNotAvailable(Exception):
    """Raised when a subtask cannot be read (missing or out of scope)."""


async def fetch_history_subtasks(*, task_id: int) -> list[dict[str, Any]]:
    """Return summaries for every non-deleted subtask of the task's session."""
    session_id = f"task-{task_id}"
    if _is_http_mode():
        store = _get_remote_history_store()
        payload = await store.list_history_subtasks(session_id)
        return payload.get("subtasks", [])
    return await asyncio.to_thread(_list_local, task_id)


async def fetch_subtask_record(*, task_id: int, subtask_id: int) -> dict[str, Any]:
    """Return one subtask's raw record, scoped to the task's session."""
    session_id = f"task-{task_id}"
    if _is_http_mode():
        store = _get_remote_history_store()
        return await store.get_history_subtask(session_id, subtask_id)
    return await asyncio.to_thread(_read_local, task_id, subtask_id)


def _list_local(task_id: int) -> list[dict[str, Any]]:
    """Package-mode summary list — delegates to the shared backend service."""
    from app.db.session import SessionLocal
    from app.services.chat.subtask_history import list_subtask_summaries
    from app.stores.tasks import task_store

    db = SessionLocal()
    try:
        task = task_store.get_by_id(db, task_id=task_id)
        if task is None:
            return []
        return list_subtask_summaries(db, task_id=task_id, user_id=task.user_id)
    finally:
        db.close()


def _read_local(task_id: int, subtask_id: int) -> dict[str, Any]:
    """Package-mode raw record read — delegates to the shared backend service."""
    from app.db.session import SessionLocal
    from app.services.chat.subtask_history import read_subtask_record
    from app.stores.tasks import task_store

    db = SessionLocal()
    try:
        task = task_store.get_by_id(db, task_id=task_id)
        record = (
            read_subtask_record(
                db, task_id=task_id, subtask_id=subtask_id, user_id=task.user_id
            )
            if task is not None
            else None
        )
        if record is None:
            raise SubtaskRecordNotAvailable("Subtask not found in this session")
        return record
    finally:
        db.close()
