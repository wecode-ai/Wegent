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
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Get chat history for a task.

    Automatically selects the appropriate loading method based on CHAT_SHELL_MODE:
    - Package mode: Direct database access via Backend's ORM
    - HTTP mode: Remote API call via /internal/chat/history

    Args:
        task_id: Task ID
        is_group_chat: Whether to include username prefix in user messages
        exclude_after_message_id: If provided, exclude messages with message_id >= this value.
        limit: If provided, limit the number of messages returned (most recent N messages).
            Used by subscription tasks to control history context size.

    Returns:
        List of message dictionaries with 'role' and 'content' keys
    """
    is_http = _is_http_mode()
    logger.debug(
        "[history] get_chat_history: task_id=%d, is_group_chat=%s, "
        "exclude_after=%s, limit=%s, is_http_mode=%s",
        task_id,
        is_group_chat,
        exclude_after_message_id,
        limit,
        is_http,
    )

    if is_http:
        history = await _load_history_from_remote(
            task_id, is_group_chat, exclude_after_message_id, limit
        )
    else:
        history = await _load_history_from_db(
            task_id, is_group_chat, exclude_after_message_id, limit
        )

    logger.debug(
        "[history] get_chat_history: loaded %d messages for task_id=%d",
        len(history),
        task_id,
    )

    # Only truncate history for group chat (if no explicit limit was provided)
    if is_group_chat and limit is None:
        return _truncate_history(history)
    return history


async def _load_history_from_remote(
    task_id: int,
    is_group_chat: bool,
    exclude_after_message_id: int | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Load chat history from Backend via RemoteHistoryStore.

    Used in HTTP mode when chat_shell runs as an independent service.

    Args:
        task_id: Task ID
        is_group_chat: Whether to include username prefix in user messages
        exclude_after_message_id: If provided, exclude messages with message_id >= this value.
        limit: If provided, limit the number of messages returned (most recent N messages).
    """
    logger.debug(
        "[history] _load_history_from_remote: START task_id=%d, is_group_chat=%s, "
        "exclude_after=%s, limit=%s",
        task_id,
        is_group_chat,
        exclude_after_message_id,
        limit,
    )

    store = _get_remote_history_store()
    session_id = f"task-{task_id}"

    try:
        # Get history from remote API
        # Note: before_message_id needs to be string for the API
        before_id = str(exclude_after_message_id) if exclude_after_message_id else None
        logger.debug(
            "[history] Calling remote store.get_history: session_id=%s, "
            "before_id=%s, is_group_chat=%s, limit=%s",
            session_id,
            before_id,
            is_group_chat,
            limit,
        )

        messages = await store.get_history(
            session_id=session_id,
            before_message_id=before_id,
            is_group_chat=is_group_chat,
            limit=limit,
        )

        logger.debug(
            "[history] Remote store returned %d messages for session_id=%s",
            len(messages),
            session_id,
        )

        # Convert Message objects to dict format expected by the agent
        # Pass through all fields from the API response to preserve extra data
        # like loaded_skills for skill state restoration
        history: list[dict[str, Any]] = []
        for msg in messages:
            # RemoteHistoryStore returns Message objects
            # Use to_dict() to get all fields and pass through directly
            msg_dict = msg.to_dict()
            history.append(msg_dict)

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
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Load chat history from database (Package mode).

    Uses asyncio.to_thread to run sync database operations.

    Args:
        task_id: Task ID
        is_group_chat: Whether to include username prefix in user messages
        exclude_after_message_id: If provided, exclude messages with message_id >= this value.
        limit: If provided, limit the number of messages returned (most recent N messages).
    """
    return await asyncio.to_thread(
        _load_history_from_db_sync,
        task_id,
        is_group_chat,
        exclude_after_message_id,
        limit,
    )


def _load_history_from_db_sync(
    task_id: int,
    is_group_chat: bool,
    exclude_after_message_id: int | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Synchronous implementation of chat history retrieval.

    In package mode, imports from backend's app.models and app.db.session.

    Args:
        task_id: Task ID
        is_group_chat: Whether to include username prefix in user messages
        exclude_after_message_id: If provided, exclude messages with message_id >= this value.
        limit: If provided, limit the number of messages returned (most recent N messages).
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

        # If limit is specified, we need to get the most recent N messages
        # First order by message_id desc to get the latest, then reverse
        if limit is not None and limit > 0:
            # Get the most recent N messages by ordering desc and limiting
            subtasks = query.order_by(Subtask.message_id.desc()).limit(limit).all()
            # Reverse to get chronological order
            subtasks = list(reversed(subtasks))
        else:
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
        image_metadata_headers: list[str] = []
        total_attachment_text_length = 0

        # Get task_id and subtask_id for building sandbox paths
        task_id = subtask.task_id
        subtask_id = subtask.id

        for attachment in attachments:
            vision_block = _build_vision_content_block(attachment)
            if vision_block:
                vision_parts.append(vision_block)
                # Add image metadata header for reference in text content
                image_header = _build_image_metadata_header(
                    attachment, task_id=task_id, subtask_id=subtask_id
                )
                image_metadata_headers.append(image_header)
                logger.info(
                    f"[history] Loaded image attachment: id={attachment.id}, "
                    f"name={attachment.name}, mime_type={attachment.mime_type}"
                )
            else:
                doc_prefix = _build_document_text_prefix(
                    attachment, task_id=task_id, subtask_id=subtask_id
                )
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

        # Combine all text parts with XML tags:
        # - attachments wrapped in <attachment> tag
        # - knowledge bases wrapped in <knowledge_base> tag
        combined_prefix = ""
        if attachment_text_parts:
            combined_prefix += (
                "<attachment>\n" + "".join(attachment_text_parts) + "</attachment>\n\n"
            )
        if kb_text_parts:
            combined_prefix += (
                "<knowledge_base>\n" + "".join(kb_text_parts) + "</knowledge_base>\n\n"
            )

        if combined_prefix:
            text_content = f"{combined_prefix}{text_content}"

        if vision_parts:
            # Add image metadata headers to text content for reference
            # Wrap image metadata in <attachment> tag for consistency with first upload
            if image_metadata_headers:
                headers_text = "\n\n".join(image_metadata_headers)
                text_content = (
                    f"<attachment>\n{headers_text}\n</attachment>\n\n{text_content}"
                )
            return {
                "role": "user",
                "content": [{"type": "text", "text": text_content}, *vision_parts],
            }
        return {"role": "user", "content": text_content}

    elif subtask.role == SubtaskRole.ASSISTANT:
        if not subtask.result or not isinstance(subtask.result, dict):
            return None
        content = subtask.result.get("value", "")
        if not content:
            return None

        msg = {"role": "assistant", "content": content}

        # Include loaded_skills for skill state restoration across conversation turns
        loaded_skills = subtask.result.get("loaded_skills")
        if loaded_skills:
            msg["loaded_skills"] = loaded_skills

        return msg

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


def _format_file_size(size_bytes: int) -> str:
    """Format file size in bytes to human-readable format."""
    if size_bytes >= 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    elif size_bytes >= 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes} bytes"


def _build_attachment_url(attachment_id: int) -> str:
    """Build the download URL for an attachment."""
    return f"/api/attachments/{attachment_id}/download"


def _build_sandbox_path(
    task_id: int | None,
    subtask_id: int | None,
    filename: str,
) -> str | None:
    """Build the sandbox file path for an attachment.

    This path corresponds to where the Executor downloads attachments
    in the sandbox environment.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        filename: Original filename

    Returns:
        Sandbox path in format: /home/user/{task_id}:executor:attachments/{subtask_id}/{filename}
        Returns None if task_id or subtask_id is not provided.
    """
    if task_id is None or subtask_id is None:
        return None
    # Guard against None filename and strip control characters
    safe_filename = (filename or "document").replace("\n", "").replace("\r", "")
    return f"/home/user/{task_id}:executor:attachments/{subtask_id}/{safe_filename}"


def _build_image_metadata_header(
    context,
    task_id: int | None = None,
    subtask_id: int | None = None,
) -> str:
    """Build image attachment metadata header string."""
    attachment_id = context.id
    filename = context.name or "image"
    mime_type = context.mime_type or "unknown"
    file_size = context.file_size if hasattr(context, "file_size") else 0
    formatted_size = _format_file_size(file_size)
    url = _build_attachment_url(attachment_id)

    # Build sandbox path if task_id and subtask_id are provided
    sandbox_path = _build_sandbox_path(task_id, subtask_id, filename)

    if sandbox_path:
        return (
            f"[Image Attachment: {filename} | ID: {attachment_id} | "
            f"Type: {mime_type} | Size: {formatted_size} | URL: {url} | "
            f"File Path in Sandbox: {sandbox_path}]"
        )
    return (
        f"[Image Attachment: {filename} | ID: {attachment_id} | "
        f"Type: {mime_type} | Size: {formatted_size} | URL: {url}]"
    )


def _build_document_text_prefix(
    context,
    task_id: int | None = None,
    subtask_id: int | None = None,
) -> str:
    """Build a text prefix for a document context (without XML tags).

    Note: This returns raw content. The caller is responsible for wrapping
    multiple attachments in a single <attachment> XML tag.

    Includes attachment metadata (id, filename, mime_type, file_size, url, sandbox_path).
    """
    if not context.extracted_text:
        return ""

    # Build attachment metadata
    attachment_id = context.id
    filename = context.name or "document"
    mime_type = context.mime_type if hasattr(context, "mime_type") else "unknown"
    file_size = context.file_size if hasattr(context, "file_size") else 0
    formatted_size = _format_file_size(file_size)
    url = _build_attachment_url(attachment_id)

    # Build sandbox path if task_id and subtask_id are provided
    sandbox_path = _build_sandbox_path(task_id, subtask_id, filename)

    if sandbox_path:
        return (
            f"[Attachment: {filename} | ID: {attachment_id} | "
            f"Type: {mime_type} | Size: {formatted_size} | URL: {url} | "
            f"File Path(already in sandbox): {sandbox_path}]\n"
            f"{context.extracted_text}\n\n"
        )
    return (
        f"[Attachment: {filename} | ID: {attachment_id} | "
        f"Type: {mime_type} | Size: {formatted_size} | URL: {url}]\n"
        f"{context.extracted_text}\n\n"
    )


def _build_knowledge_base_text_prefix(context) -> str:
    """Build a text prefix for a knowledge base context (without XML tags).

    Note: This returns raw content. The caller is responsible for wrapping
    multiple knowledge base contents in a single <knowledge_base> XML tag.
    """
    if not context.extracted_text:
        return ""

    kb_name = context.name or "Knowledge Base"
    kb_id = context.knowledge_id or "unknown"
    return f"[Knowledge Base: {kb_name} (ID: {kb_id})]\n{context.extracted_text}\n\n"


def _truncate_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Truncate chat history keeping first N and last M messages.

    This is used for group chat to reduce prompt length while retaining
    the start of the conversation and the most recent context.
    """

    first_n = settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES
    last_n = settings.GROUP_CHAT_HISTORY_LAST_MESSAGES

    # Handle edge case where both values are 0 or negative
    if first_n <= 0 and last_n <= 0:
        return history

    if len(history) <= first_n + last_n:
        return history

    # Handle edge case: history[-0:] returns full list, not empty list
    tail = history[-last_n:] if last_n > 0 else []
    return [*history[:first_n], *tail]
