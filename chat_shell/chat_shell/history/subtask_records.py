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

_PREVIEW_CHARS = 200


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


def _primary_text(subtask: Any) -> str:
    """Un-compacted plain text of a subtask (matches the backend endpoint)."""
    from app.models.subtask import SubtaskRole

    if subtask.role == SubtaskRole.USER:
        return subtask.prompt or ""
    result = subtask.result if isinstance(subtask.result, dict) else {}
    value = result.get("value")
    return value if isinstance(value, str) else ""


def _list_local(task_id: int) -> list[dict[str, Any]]:
    """Package-mode summary list with the same scoping as the endpoint."""
    from app.db.session import SessionLocal
    from app.models.subtask import Subtask, SubtaskStatus

    db = SessionLocal()
    try:
        rows = (
            db.query(Subtask)
            .filter(Subtask.task_id == task_id)
            .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
            .all()
        )
        summaries = []
        for st in rows:
            if st.status == SubtaskStatus.DELETE:
                continue
            text = _primary_text(st)
            summaries.append(
                {
                    "id": st.id,
                    "role": st.role.value.lower(),
                    "status": st.status.value,
                    "char_count": len(text),
                    "preview": text[:_PREVIEW_CHARS],
                }
            )
        return summaries
    finally:
        db.close()


def _read_local(task_id: int, subtask_id: int) -> dict[str, Any]:
    """Package-mode raw record read, scoped to the task."""
    from app.db.session import SessionLocal
    from app.models.subtask import Subtask, SubtaskRole

    db = SessionLocal()
    try:
        subtask = (
            db.query(Subtask)
            .filter(Subtask.id == subtask_id, Subtask.task_id == task_id)
            .first()
        )
        if subtask is None:
            raise SubtaskRecordNotAvailable("Subtask not found in this session")

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
    finally:
        db.close()
