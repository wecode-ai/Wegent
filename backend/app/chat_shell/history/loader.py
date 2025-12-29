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
    from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
    from app.models.user import User
    from app.services.chat.storage.db import _db_session
    from app.services.context import context_service

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
                db, subtask, sender_username, context_service, is_group_chat
            )
            if msg:
                history.append(msg)

    return history


def _build_history_message(
    db,
    subtask,
    sender_username: str | None,
    context_service,
    is_group_chat: bool = False,
) -> dict[str, Any] | None:
    """Build a single history message from a subtask.

    For user messages, this function:
    1. Loads all contexts (attachments and knowledge_base) in one query
    2. Processes attachments first (images or text) - they have priority
    3. Processes knowledge_base contexts with remaining token space
    4. Follows MAX_EXTRACTED_TEXT_LENGTH limit with attachments having priority
    """
    from app.models.subtask import SubtaskRole
    from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext

    if subtask.role == SubtaskRole.USER:
        # Build text content
        text_content = subtask.prompt or ""
        if is_group_chat and sender_username:
            text_content = f"User[{sender_username}]: {text_content}"

        # Load all contexts in one query and separate by type
        all_contexts = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == subtask.id,
                SubtaskContext.status == ContextStatus.READY.value,
                SubtaskContext.context_type.in_(
                    [ContextType.ATTACHMENT.value, ContextType.KNOWLEDGE_BASE.value]
                ),
            )
            .order_by(SubtaskContext.created_at)
            .all()
        )

        if not all_contexts:
            return {"role": "user", "content": text_content}

        # Separate contexts by type
        attachments = [
            c for c in all_contexts if c.context_type == ContextType.ATTACHMENT.value
        ]
        kb_contexts = [
            c
            for c in all_contexts
            if c.context_type == ContextType.KNOWLEDGE_BASE.value
        ]

        # Process attachments first (they have priority)
        vision_parts: list[dict[str, Any]] = []
        attachment_text_parts: list[str] = []
        total_attachment_text_length = 0

        for attachment in attachments:
            vision_block = context_service.build_vision_content_block(attachment)
            if vision_block:
                vision_parts.append(vision_block)
                logger.info(
                    f"[history] Loaded image attachment: id={attachment.id}, "
                    f"name={attachment.name}, mime_type={attachment.mime_type}"
                )
            else:
                doc_prefix = context_service.build_document_text_prefix(attachment)
                if doc_prefix:
                    attachment_text_parts.append(doc_prefix)
                    total_attachment_text_length += len(doc_prefix)
                    logger.info(
                        f"[history] Loaded attachment: id={attachment.id}, "
                        f"name={attachment.name}, text_len={attachment.text_length}, "
                        f'preview="{attachment.text_preview}"'
                    )

        # Calculate remaining token space for knowledge base content
        max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
        remaining_space = max_text_length - total_attachment_text_length

        # Process knowledge base contexts with remaining space
        kb_text_parts: list[str] = []
        current_kb_length = 0

        for kb_ctx in kb_contexts:
            if remaining_space <= 0:
                logger.debug(
                    f"No remaining space for knowledge base context {kb_ctx.id}"
                )
                break

            kb_prefix = context_service.build_knowledge_base_text_prefix(kb_ctx)
            if kb_prefix:
                prefix_length = len(kb_prefix)
                if current_kb_length + prefix_length <= remaining_space:
                    kb_text_parts.append(kb_prefix)
                    current_kb_length += prefix_length
                    logger.info(
                        f"[history] Loaded knowledge base: id={kb_ctx.id}, "
                        f"name={kb_ctx.name}, kb_id={kb_ctx.knowledge_id}, "
                        f'text_len={kb_ctx.text_length}, preview="{kb_ctx.text_preview}"'
                    )
                else:
                    # Truncate if partial space available
                    available = remaining_space - current_kb_length
                    if available > 100:  # Only include if meaningful content remains
                        truncated_prefix = (
                            kb_prefix[:available] + "\n(truncated...)\n\n"
                        )
                        kb_text_parts.append(truncated_prefix)
                        logger.info(
                            f"[history] Loaded knowledge base (truncated): id={kb_ctx.id}, "
                            f"name={kb_ctx.name}, kb_id={kb_ctx.knowledge_id}, "
                            f"truncated_to={available} chars"
                        )
                    break

        # Combine all text parts: attachments first, then knowledge bases
        all_text_parts = attachment_text_parts + kb_text_parts
        if all_text_parts:
            combined_prefix = "".join(all_text_parts)
            text_content = f"{combined_prefix}{text_content}"

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


def get_knowledge_base_meta_prompt(
    db,
    task_id: int,
) -> str:
    """
    Build knowledge base meta information prompt for system prompt injection.

    This function collects all unique knowledge bases from the task's history
    and formats them as a prompt section for the Agent.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        Formatted prompt string with knowledge base meta information,
        or empty string if no knowledge bases are found
    """
    from app.services.context import context_service

    kb_meta_list = context_service.get_knowledge_base_meta_for_task(db, task_id)

    if not kb_meta_list:
        return ""

    # Build the prompt section
    kb_lines = []
    for kb_meta in kb_meta_list:
        kb_name = kb_meta.get("kb_name", "Unknown")
        kb_id = kb_meta.get("kb_id", "N/A")
        kb_lines.append(f"- KB Name: {kb_name}, KB ID: {kb_id}")

    kb_list_str = "\n".join(kb_lines)

    prompt = f"""
Available Knowledge Bases (from conversation context):
{kb_list_str}

Note: The knowledge base content has been pre-filled from history. If the provided information is insufficient, you can use the knowledge_base_search tool to retrieve more relevant content.
"""

    return prompt
