# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat history loader for Chat Service.

This module provides functions to load and process chat history from database.
"""

import asyncio
import logging
from typing import Any

from app.core.config import settings
from app.services.streaming import truncate_list_keep_ends

logger = logging.getLogger(__name__)


async def get_chat_history(
    task_id: int,
    is_group_chat: bool,
    exclude_after_message_id: int | None = None,
) -> list[dict[str, Any]]:
    """Get chat history for a task directly from database.

    Args:
        task_id: Task ID
        is_group_chat: Whether to include username prefix in user messages
        exclude_after_message_id: If provided, exclude messages with message_id >= this value.

    Returns:
        List of message dictionaries
    """
    history = await _load_history_from_db(
        task_id, is_group_chat, exclude_after_message_id
    )
    # Only truncate history for group chat
    if is_group_chat:
        return _truncate_history(history)
    return history


async def _load_history_from_db(
    task_id: int,
    is_group_chat: bool,
    exclude_after_message_id: int | None = None,
) -> list[dict[str, Any]]:
    """Load chat history from database."""
    return await asyncio.to_thread(
        _load_history_from_db_sync,
        task_id,
        is_group_chat,
        exclude_after_message_id,
    )


def _load_history_from_db_sync(
    task_id: int,
    is_group_chat: bool,
    exclude_after_message_id: int | None = None,
) -> list[dict[str, Any]]:
    """Synchronous implementation of chat history retrieval."""
    from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
    from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment
    from app.models.user import User
    from app.services.attachment import attachment_service
    from app.services.chat.storage.db import _db_session

    history: list[dict[str, Any]] = []
    with _db_session() as db:
        query = (
            db.query(Subtask, User.user_name)
            .outerjoin(User, Subtask.sender_user_id == User.id)
            .filter(
                Subtask.task_id == task_id,
                Subtask.status == SubtaskStatus.COMPLETED,
            )
        )

        if exclude_after_message_id is not None:
            query = query.filter(Subtask.message_id < exclude_after_message_id)

        subtasks = query.order_by(Subtask.message_id.asc()).all()

        for subtask, sender_username in subtasks:
            msg = _build_history_message(
                db, subtask, sender_username, attachment_service, is_group_chat
            )
            if msg:
                history.append(msg)

    return history


def _build_history_message(
    db,
    subtask,
    sender_username: str | None,
    attachment_service,
    is_group_chat: bool = False,
) -> dict[str, Any] | None:
    """Build a single history message from a subtask."""
    from app.models.subtask import SubtaskRole
    from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment

    if subtask.role == SubtaskRole.USER:
        # Build text content
        text_content = subtask.prompt or ""
        if is_group_chat and sender_username:
            text_content = f"User[{sender_username}]: {text_content}"

        # Get attachments
        attachments = (
            db.query(SubtaskAttachment)
            .filter(
                SubtaskAttachment.subtask_id == subtask.id,
                SubtaskAttachment.status == AttachmentStatus.READY,
            )
            .all()
        )

        if not attachments:
            return {"role": "user", "content": text_content}

        # Process attachments
        vision_parts: list[dict[str, Any]] = []
        for attachment in attachments:
            vision_block = attachment_service.build_vision_content_block(attachment)
            if vision_block:
                vision_parts.append(vision_block)
            else:
                doc_prefix = attachment_service.build_document_text_prefix(attachment)
                if doc_prefix:
                    text_content = f"{doc_prefix}{text_content}"

        if vision_parts:
            return {
                "role": "user",
                "content": [{"type": "text", "text": text_content}, *vision_parts],
            }
        return {"role": "user", "content": text_content}

    elif subtask.role == SubtaskRole.ASSISTANT:
        if not subtask.result or not isinstance(subtask.result, dict):
            return None
        content = subtask.result.get("value", "")
        return {"role": "assistant", "content": content} if content else None

    return None


def _truncate_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Truncate chat history keeping first N and last M messages."""
    return truncate_list_keep_ends(
        history,
        settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES,
        settings.GROUP_CHAT_HISTORY_LAST_MESSAGES,
    )
