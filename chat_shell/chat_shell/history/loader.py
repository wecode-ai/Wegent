# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat history loader for Chat Service.

This module provides functions to load and process chat history.

For Package Mode (CHAT_SHELL_MODE=package):
- Uses asyncio.to_thread to run sync database operations
- Imports backend's models and database session directly
- Used when chat_shell runs within the backend process

For HTTP Mode (CHAT_SHELL_MODE=http):
- Uses RemoteHistoryStore to call Backend's /internal/chat/history API
- chat_shell runs as an independent HTTP service
- Session ID format: "task-{task_id}"
"""

import asyncio
import logging
from typing import Any, List, Optional

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)

# Global remote history store instance (lazy initialized for HTTP mode)
_remote_history_store: Optional["RemoteHistoryStore"] = None


def _get_remote_history_store() -> "RemoteHistoryStore":
    """Get or create the remote history store for HTTP mode."""
    global _remote_history_store
    if _remote_history_store is None:
        from chat_shell.storage.remote import RemoteHistoryStore

        if not settings.REMOTE_STORAGE_URL:
            raise ValueError(
                "REMOTE_STORAGE_URL is required for HTTP mode. "
                "Set CHAT_SHELL_REMOTE_STORAGE_URL environment variable."
            )
        # Note: REMOTE_STORAGE_TOKEN is optional for internal API calls
        # The internal API doesn't require authentication
        if settings.REMOTE_STORAGE_TOKEN:
            logger.debug("[history] Using REMOTE_STORAGE_TOKEN for remote storage auth")
        else:
            logger.debug(
                "[history] No REMOTE_STORAGE_TOKEN set, internal API will use unauthenticated requests"
            )

        _remote_history_store = RemoteHistoryStore(
            base_url=settings.REMOTE_STORAGE_URL,
            auth_token=settings.REMOTE_STORAGE_TOKEN,
            timeout=30.0,
        )
        logger.debug(
            "[history] Initialized RemoteHistoryStore: base_url=%s",
            settings.REMOTE_STORAGE_URL,
        )

    return _remote_history_store


async def close_remote_history_store() -> None:
    """Close the remote history store connection."""
    global _remote_history_store
    if _remote_history_store is not None:
        await _remote_history_store.close()
        _remote_history_store = None
        logger.info("[history] Closed RemoteHistoryStore")


def _is_http_mode() -> bool:
    """Check if running in HTTP mode with remote storage.

    The detection logic:
    1. Check CHAT_SHELL_MODE and STORAGE_TYPE settings first
    2. If mode is "http" and storage is "remote", use remote storage
    3. Otherwise, try to import Backend's ORM models for package mode
    """
    # Check explicit settings first
    mode = settings.CHAT_SHELL_MODE.lower()
    storage = settings.STORAGE_TYPE.lower()

    logger.debug(
        "[history] _is_http_mode check: CHAT_SHELL_MODE=%s, STORAGE_TYPE=%s",
        mode,
        storage,
    )

    # If explicitly configured for HTTP mode with remote storage, use it
    if mode == "http" and storage == "remote":
        logger.debug("[history] Using remote storage (HTTP mode configured)")
        return True

    # Otherwise, check if we can import Backend's models (package mode)
    try:
        from app.models.subtask import Subtask  # noqa: F401

        # Import succeeded - we're in Backend process, use direct DB access
        logger.debug("[history] Using direct DB access (app.models available)")
        return False
    except ImportError:
        # Cannot import Backend models - we're running independently
        # But not configured for remote storage
        logger.warning(
            "[history] Cannot import app.models but not configured for remote storage. "
            "Set CHAT_SHELL_MODE=http and STORAGE_TYPE=remote for HTTP mode."
        )
        return False


async def get_chat_history(
    task_id: int,
    is_group_chat: bool,
    exclude_after_message_id: int | None = None,
) -> list[dict[str, Any]]:
    """Get chat history for a task.

    Automatically selects the appropriate loading method based on CHAT_SHELL_MODE:
    - Package mode: Direct database access via Backend's ORM
    - HTTP mode: Remote API call via /internal/chat/history

    Args:
        task_id: Task ID
        is_group_chat: Whether to include username prefix in user messages
        exclude_after_message_id: If provided, exclude messages with message_id >= this value.

    Returns:
        List of message dictionaries with 'role' and 'content' keys
    """
    is_http = _is_http_mode()
    logger.debug(
        "[history] get_chat_history: task_id=%d, is_group_chat=%s, "
        "exclude_after=%s, is_http_mode=%s",
        task_id,
        is_group_chat,
        exclude_after_message_id,
        is_http,
    )

    if is_http:
        history = await _load_history_from_remote(
            task_id, is_group_chat, exclude_after_message_id
        )
    else:
        history = await _load_history_from_db(
            task_id, is_group_chat, exclude_after_message_id
        )

    logger.debug(
        "[history] get_chat_history: loaded %d messages for task_id=%d",
        len(history),
        task_id,
    )

    # Only truncate history for group chat
    if is_group_chat:
        return _truncate_history(history)
    return history


async def _load_history_from_remote(
    task_id: int,
    is_group_chat: bool,
    exclude_after_message_id: int | None = None,
) -> list[dict[str, Any]]:
    """Load chat history from Backend via RemoteHistoryStore.

    Used in HTTP mode when chat_shell runs as an independent service.
    """
    logger.debug(
        "[history] _load_history_from_remote: START task_id=%d, is_group_chat=%s, "
        "exclude_after=%s",
        task_id,
        is_group_chat,
        exclude_after_message_id,
    )

    store = _get_remote_history_store()
    session_id = f"task-{task_id}"

    try:
        # Get history from remote API
        # Note: before_message_id needs to be string for the API
        before_id = str(exclude_after_message_id) if exclude_after_message_id else None
        logger.debug(
            "[history] Calling remote store.get_history: session_id=%s, "
            "before_id=%s, is_group_chat=%s",
            session_id,
            before_id,
            is_group_chat,
        )

        messages = await store.get_history(
            session_id=session_id,
            before_message_id=before_id,
            is_group_chat=is_group_chat,
        )

        logger.debug(
            "[history] Remote store returned %d messages for session_id=%s",
            len(messages),
            session_id,
        )

        # Convert Message objects to dict format expected by the agent
        history: list[dict[str, Any]] = []
        for msg in messages:
            # RemoteHistoryStore returns Message objects
            msg_dict = msg.to_dict()

            # The Backend API now handles username prefix for group chat
            # So we just use the content as-is

            history.append(
                {
                    "role": msg_dict.get("role", "user"),
                    "content": msg_dict.get("content", ""),
                }
            )

        logger.debug(
            "[history] _load_history_from_remote: SUCCESS loaded %d messages "
            "for task_id=%d, is_group_chat=%s",
            len(history),
            task_id,
            is_group_chat,
        )
        return history

    except Exception as e:
        logger.error(
            "[history] _load_history_from_remote: FAILED task_id=%d, error=%s",
            task_id,
            e,
            exc_info=True,
        )
        # Return empty history on error to allow conversation to continue
        return []


async def _load_history_from_db(
    task_id: int,
    is_group_chat: bool,
    exclude_after_message_id: int | None = None,
) -> list[dict[str, Any]]:
    """Load chat history from database (Package mode).

    Uses asyncio.to_thread to run sync database operations.
    """
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
    """Synchronous implementation of chat history retrieval.

    In package mode, imports from backend's app.models and app.db.session.
    """
    # Import backend's models and database session
    # This works in package mode since we're running within the backend process
    from app.db.session import SessionLocal
    from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
    from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
    from app.models.user import User

    history: list[dict[str, Any]] = []

    db = SessionLocal()
    try:
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
            msg = _build_history_message(db, subtask, sender_username, is_group_chat)
            if msg:
                history.append(msg)
    finally:
        db.close()

    return history


def _build_history_message(
    db,
    subtask,
    sender_username: str | None,
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
            vision_block = _build_vision_content_block(attachment)
            if vision_block:
                vision_parts.append(vision_block)
                logger.info(
                    f"[history] Loaded image attachment: id={attachment.id}, "
                    f"name={attachment.name}, mime_type={attachment.mime_type}"
                )
            else:
                doc_prefix = _build_document_text_prefix(attachment)
                if doc_prefix:
                    attachment_text_parts.append(doc_prefix)
                    total_attachment_text_length += len(doc_prefix)
                    logger.info(
                        f"[history] Loaded attachment: id={attachment.id}, "
                        f"name={attachment.name}, text_len={attachment.text_length}, "
                        f'preview="{attachment.text_preview}"'
                    )

        # Calculate remaining token space for knowledge base content
        max_text_length = getattr(settings, "MAX_EXTRACTED_TEXT_LENGTH", 100000)
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

            kb_prefix = _build_knowledge_base_text_prefix(kb_ctx)
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


def _build_vision_content_block(context) -> dict[str, Any] | None:
    """Build a vision content block from a context if it's an image."""
    if not context.mime_type or not context.mime_type.startswith("image/"):
        return None

    if not context.binary_data:
        return None

    import base64

    encoded_data = base64.b64encode(context.binary_data).decode("utf-8")
    return {
        "type": "image_url",
        "image_url": {
            "url": f"data:{context.mime_type};base64,{encoded_data}",
        },
    }


def _build_document_text_prefix(context) -> str:
    """Build a text prefix for a document context."""
    if not context.extracted_text:
        return ""

    name = context.name or "document"
    return f"[Document: {name}]\n{context.extracted_text}\n\n"


def _build_knowledge_base_text_prefix(context) -> str:
    """Build a text prefix for a knowledge base context."""
    if not context.extracted_text:
        return ""

    kb_name = context.name or "Knowledge Base"
    kb_id = context.knowledge_id or "unknown"
    return f"[Knowledge Base: {kb_name} (ID: {kb_id})]\n{context.extracted_text}\n\n"


def _truncate_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Truncate chat history keeping first N and last M messages."""
    first_n = getattr(settings, "GROUP_CHAT_HISTORY_FIRST_MESSAGES", 5)
    last_m = getattr(settings, "GROUP_CHAT_HISTORY_LAST_MESSAGES", 10)

    if len(history) <= first_n + last_m:
        return history

    return history[:first_n] + history[-last_m:]


def get_knowledge_base_meta_prompt(
    db,
    task_id: int,
) -> str:
    """
    Build knowledge base meta information prompt for system prompt injection.

    This is a synchronous function called from backend's preprocessing code.
    Only used in Package mode.

    Args:
        db: Database session (from backend)
        task_id: Task ID

    Returns:
        Formatted prompt string with knowledge base meta information,
        or empty string if no knowledge bases are found
    """
    kb_meta_list = get_knowledge_base_meta_for_task(db, task_id)

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


def get_knowledge_base_meta_for_task(
    db,
    task_id: int,
) -> List[dict]:
    """
    Get list of knowledge base meta information for a task.

    This is a synchronous function. Only used in Package mode.

    Args:
        db: Database session (from backend)
        task_id: Task ID

    Returns:
        List of dicts with kb_name and kb_id
    """
    from app.models.subtask import Subtask
    from app.models.subtask_context import ContextType, SubtaskContext

    try:
        # Get all subtask IDs for this task
        subtask_ids = [
            row[0]
            for row in db.query(Subtask.id).filter(Subtask.task_id == task_id).all()
        ]

        if not subtask_ids:
            return []

        # Get knowledge base contexts
        # Note: knowledge_id is stored in type_data JSON, not a direct column
        contexts = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id.in_(subtask_ids),
                SubtaskContext.context_type == ContextType.KNOWLEDGE_BASE.value,
            )
            .all()
        )

        kb_meta_list = []
        seen_kb_ids = set()

        for ctx in contexts:
            # knowledge_id is a @property that extracts from type_data
            kb_id = ctx.knowledge_id
            if kb_id and kb_id not in seen_kb_ids:
                seen_kb_ids.add(kb_id)
                kb_meta_list.append(
                    {
                        "kb_name": ctx.name or "Unknown",
                        "kb_id": kb_id,
                    }
                )

        return kb_meta_list

    except Exception as e:
        logger.warning(f"[history] Failed to get KB meta for task {task_id}: {e}")
        return []
