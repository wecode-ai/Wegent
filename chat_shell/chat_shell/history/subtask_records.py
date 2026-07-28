# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fetch history subtask summaries and record pages for AI backtracking.

Mirrors the loader's mode switch: HTTP mode calls the backend internal endpoints
(``/chat/history/{session_id}/subtasks[/{id}]``) via ``RemoteHistoryStore``;
package mode calls the shared backend service directly. Both enforce the same
session (task) scoping, and pagination + rendering live in that shared service —
this module is only the transport switch.
"""

from __future__ import annotations

import asyncio
from typing import Any

from chat_shell.history.loader import _get_remote_history_store, _is_http_mode


class SubtaskRecordNotAvailable(Exception):
    """Raised when a subtask cannot be read (missing or out of scope)."""


async def fetch_history_subtasks(
    *, task_id: int, limit: int | None = None, offset: int = 0
) -> dict[str, Any]:
    """A page of subtask summaries: ``{subtasks, total, has_more}``."""
    session_id = f"task-{task_id}"
    if _is_http_mode():
        store = _get_remote_history_store()
        return await store.list_history_subtasks(session_id, limit=limit, offset=offset)
    return await asyncio.to_thread(_list_local, task_id, limit, offset)


async def fetch_subtask_record(
    *, task_id: int, subtask_id: int, cursor: str = "0:0", max_chars: int = 0
) -> dict[str, Any]:
    """One page of a subtask's rendered transcript, scoped to the task."""
    session_id = f"task-{task_id}"
    if _is_http_mode():
        store = _get_remote_history_store()
        return await store.get_history_subtask(
            session_id, subtask_id, cursor=cursor, max_chars=max_chars
        )
    return await asyncio.to_thread(_read_local, task_id, subtask_id, cursor, max_chars)


def _list_local(task_id: int, limit: int | None, offset: int) -> dict[str, Any]:
    """Package-mode summary list — delegates to the shared backend service."""
    from app.db.session import SessionLocal
    from app.services.chat.subtask_history import list_subtask_summaries
    from app.stores.tasks import task_store

    db = SessionLocal()
    try:
        task = task_store.get_by_id(db, task_id=task_id)
        if task is None:
            return {"subtasks": [], "total": 0, "has_more": False}
        return list_subtask_summaries(
            db, task_id=task_id, user_id=task.user_id, limit=limit, offset=offset
        )
    finally:
        db.close()


def _read_local(
    task_id: int, subtask_id: int, cursor: str, max_chars: int
) -> dict[str, Any]:
    """Package-mode record page — delegates to the shared backend service."""
    from app.db.session import SessionLocal
    from app.services.chat.subtask_history import read_subtask_record
    from app.stores.tasks import task_store

    db = SessionLocal()
    try:
        task = task_store.get_by_id(db, task_id=task_id)
        record = (
            read_subtask_record(
                db,
                task_id=task_id,
                subtask_id=subtask_id,
                user_id=task.user_id,
                cursor=cursor,
                max_chars=max_chars,
            )
            if task is not None
            else None
        )
        if record is None:
            raise SubtaskRecordNotAvailable("Subtask not found in this session")
        return record
    finally:
        db.close()
