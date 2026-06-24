# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fetch a character slice of an attachment's extracted text.

Mirrors the loader's mode switch: HTTP mode calls the backend internal endpoint
(``/chat/attachments/{id}/text``) via ``RemoteHistoryStore``; package mode reads
the database directly. Both enforce the same task scoping as the endpoint (the
attachment's subtask must belong to the task, or be unlinked).

The returned payload matches the backend ``AttachmentTextResponse`` shape:
``{attachment_id, name, mime_type, total_chars, offset, text, has_more}``.
"""

from __future__ import annotations

import asyncio
from typing import Any

from chat_shell.history.loader import _get_remote_history_store, _is_http_mode


class AttachmentNotAvailable(Exception):
    """Raised when an attachment cannot be read (missing or out of scope)."""


async def fetch_attachment_text(
    *,
    task_id: int,
    attachment_id: int,
    offset: int,
    limit: int,
) -> dict[str, Any]:
    """Return a character slice of *attachment_id*'s extracted text."""
    session_id = f"task-{task_id}"
    if _is_http_mode():
        store = _get_remote_history_store()
        return await store.get_attachment_text(session_id, attachment_id, offset, limit)
    return await asyncio.to_thread(_fetch_local, task_id, attachment_id, offset, limit)


def _fetch_local(
    task_id: int, attachment_id: int, offset: int, limit: int
) -> dict[str, Any]:
    """Package-mode DB read with the same task scoping as the endpoint."""
    from app.db.session import SessionLocal
    from app.models.subtask import Subtask
    from app.models.subtask_context import (
        ContextStatus,
        ContextType,
        SubtaskContext,
    )

    db = SessionLocal()
    try:
        context = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.id == attachment_id,
                SubtaskContext.context_type == ContextType.ATTACHMENT.value,
                SubtaskContext.status == ContextStatus.READY.value,
            )
            .first()
        )
        if context is None:
            raise AttachmentNotAvailable("Attachment not found")

        task_subtask_ids = {
            row[0]
            for row in db.query(Subtask.id).filter(Subtask.task_id == task_id).all()
        }
        if not (context.subtask_id == 0 or context.subtask_id in task_subtask_ids):
            raise AttachmentNotAvailable(
                "Attachment does not belong to this conversation"
            )

        full_text = context.extracted_text or ""
        chunk = full_text[offset : offset + limit]
        return {
            "attachment_id": attachment_id,
            "name": context.name or "",
            "mime_type": context.mime_type or "",
            "total_chars": len(full_text),
            "offset": offset,
            "text": chunk,
            "has_more": offset + len(chunk) < len(full_text),
        }
    finally:
        db.close()
