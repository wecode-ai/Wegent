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
from typing import Any, Optional

from chat_shell.core.config import settings
from chat_shell.messages.utils import group_tool_call_messages as _group_messages
from shared.prompts.constants import parse_prompt_blocks

logger = logging.getLogger(__name__)

# Prefixes for system-context text blocks that are already persisted in
# SubtaskContext (LONGTEXT) and re-injected at history-load time.
# These blocks are filtered out when persisting to subtask.prompt.
_CONTEXT_BLOCK_PREFIXES = (
    "<attachment>",
    "<knowledge_base>",
    "<selected_documents>",
    "<system-reminder>",
)


def _extract_user_text(content: list[dict[str, Any]]) -> str | None:
    """Extract the user's plain text from a content block list.

    The first text block that does not start with a known context prefix
    is treated as the user's own message.  Returns ``None`` if no user
    text block is found.
    """
    for block in content:
        if block.get("type") != "text":
            continue
        text = block.get("text", "")
        if not text.lstrip().startswith(_CONTEXT_BLOCK_PREFIXES):
            return text
    return None


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


async def update_user_message_content(
    task_id: int,
    user_subtask_id: int,
    content: Any,
) -> None:
    """Persist the user's plain text message to the DB.

    Context blocks (attachments, knowledge base, selected documents) and
    the ``<system-reminder>`` block are **not** stored — they are already
    persisted in ``SubtaskContext`` (LONGTEXT) and re-injected at
    history-load time.  Storing only the plain text keeps the value well
    under the MySQL TEXT column limit and ensures the frontend can display
    it directly without JSON parsing.

    Args:
        task_id: Task ID (used to build the session_id for HTTP mode)
        user_subtask_id: ID of the user Subtask record to update
        content: Formatted content — either a string or a list of content blocks
    """
    if isinstance(content, list):
        # Extract the user's own text; skip context / image / reminder blocks.
        storage_content: Any = _extract_user_text(content) or ""
    else:
        storage_content = content

    is_http = _is_http_mode()
    if is_http:
        await _update_user_message_remote(task_id, user_subtask_id, storage_content)
    else:
        await asyncio.to_thread(
            _update_user_message_in_db_sync, user_subtask_id, storage_content
        )


async def _update_user_message_remote(
    task_id: int,
    user_subtask_id: int,
    content: Any,
) -> None:
    """Update user message via RemoteHistoryStore (HTTP mode)."""
    try:
        store = _get_remote_history_store()
        session_id = f"task-{task_id}"
        await store.update_message(
            session_id=session_id,
            message_id=str(user_subtask_id),
            content=content,
        )
        logger.debug(
            "[history] Updated user message in remote store: "
            "task_id=%d, user_subtask_id=%d",
            task_id,
            user_subtask_id,
        )
    except Exception as e:
        # Non-fatal: prefix caching degrades gracefully if the update fails
        logger.warning(
            "[history] Failed to update user message (task_id=%d, "
            "user_subtask_id=%d): %s",
            task_id,
            user_subtask_id,
            e,
        )


def _update_user_message_in_db_sync(user_subtask_id: int, content: Any) -> None:
    """Update user message directly in DB (package mode)."""
    try:
        from app.db.session import SessionLocal
        from app.models.subtask import Subtask, SubtaskRole

        db = SessionLocal()
        try:
            subtask = db.query(Subtask).filter(Subtask.id == user_subtask_id).first()
            if subtask and subtask.role == SubtaskRole.USER:
                subtask.prompt = (
                    str(content) if not isinstance(content, str) else content
                )
                db.commit()
                logger.debug(
                    "[history] Updated user message in DB: user_subtask_id=%d",
                    user_subtask_id,
                )
        finally:
            db.close()
    except Exception as e:
        logger.warning(
            "[history] Failed to update user message in DB " "(user_subtask_id=%d): %s",
            user_subtask_id,
            e,
        )


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

    if limit is not None and limit <= 0:
        logger.info(
            "[history] get_chat_history: history disabled by limit=%s for task_id=%d",
            limit,
            task_id,
        )
        return []

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
                Subtask.status.in_([SubtaskStatus.COMPLETED, SubtaskStatus.FAILED]),
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
            msgs = _build_history_messages(db, subtask, sender_username, is_group_chat)
            history.extend(msgs)
    finally:
        db.close()

    return history


def _build_history_messages(
    db,
    subtask,
    sender_username: str | None,
    is_group_chat: bool = False,
) -> list[dict[str, Any]]:
    """Build history messages from a subtask.

    Returns a list of message dicts because a single assistant subtask may
    expand into multiple messages when it contains a ``messages_chain``
    (intermediate tool call / tool result messages).

    For user messages, this function:
    1. Loads all contexts (attachments and knowledge_base) in one query
    2. Processes attachments first (images or text) - they have priority
    3. Processes knowledge_base contexts with remaining token space
    4. Follows MAX_EXTRACTED_TEXT_LENGTH limit with attachments having priority
    """
    from app.models.subtask import SubtaskRole
    from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext

    if subtask.role == SubtaskRole.USER:
        # Parse multi-block prompt format (JSON array with system-reminder blocks).
        raw_prompt = subtask.prompt or ""
        text_content, extra_blocks = parse_prompt_blocks(raw_prompt)
        # Detect structured prompts: the prompt was a stored JSON array even when
        # extra_blocks is empty (e.g. a single-block array after image stripping).
        is_structured_prompt = bool(extra_blocks) or text_content != raw_prompt

        # For group chat, prefix is already embedded by build_messages when the
        # message was first sent.  However legacy structured prompts (JSON arrays
        # stored before the prefix-baking change) may lack the prefix.  Check the
        # actual text content instead of relying solely on the format flag.
        if is_group_chat and sender_username:
            expected_prefix = f"User[{sender_username}]:"
            if not text_content.lstrip().startswith(expected_prefix):
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
            if is_structured_prompt:
                content_blocks: list[dict[str, Any]] = [
                    {"type": "text", "text": text_content},
                    *extra_blocks,
                ]
                return [{"role": "user", "content": content_blocks}]
            return [{"role": "user", "content": text_content}]

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

        # Output assembly.
        #
        # Context content (attachment text, KB text) is always rebuilt from
        # SubtaskContext records — the source of truth.  Each context type
        # becomes its own independent text block (not wrapped in
        # <system-reminder>).  This matches the format produced by
        # MessageConverter._convert_responses_api_to_langchain().

        context_blocks: list[dict[str, Any]] = []
        if attachment_text_parts:
            context_blocks.append(
                {
                    "type": "text",
                    "text": "<attachment>"
                    + "".join(attachment_text_parts)
                    + "</attachment>",
                }
            )
        if kb_text_parts:
            context_blocks.append(
                {
                    "type": "text",
                    "text": "<knowledge_base>"
                    + "".join(kb_text_parts)
                    + "</knowledge_base>",
                }
            )

        if vision_parts:
            # Add image metadata headers as attachment context
            if image_metadata_headers:
                img_text = "".join(image_metadata_headers)
                attachment_idx = next(
                    (
                        i
                        for i, b in enumerate(context_blocks)
                        if b["text"].startswith("<attachment>")
                    ),
                    None,
                )
                if attachment_idx is None:
                    context_blocks.insert(
                        0,
                        {
                            "type": "text",
                            "text": f"<attachment>{img_text}</attachment>",
                        },
                    )
                else:
                    old = context_blocks[attachment_idx]["text"]
                    inner = old[len("<attachment>") : -len("</attachment>")]
                    context_blocks[attachment_idx] = {
                        "type": "text",
                        "text": f"<attachment>{img_text}{inner}</attachment>",
                    }

            multimodal_blocks: list[dict[str, Any]] = [
                {"type": "text", "text": text_content},
                *vision_parts,
                *context_blocks,
            ]
            return [{"role": "user", "content": multimodal_blocks}]

        # Text-only path
        if context_blocks:
            return [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": text_content},
                        *context_blocks,
                    ],
                }
            ]
        if is_structured_prompt:
            return [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": text_content}],
                }
            ]
        return [{"role": "user", "content": text_content}]

    elif subtask.role == SubtaskRole.ASSISTANT:
        if not subtask.result or not isinstance(subtask.result, dict):
            return []

        # For FAILED assistant subtasks, only include result.value (if any).
        # Do not expand messages_chain for failed turns.
        if subtask.status == SubtaskStatus.FAILED:
            content = subtask.result.get("value", "")
            if not content:
                return []
            return [{"role": "assistant", "content": content}]

        # If messages_chain is available, use it to reconstruct the full
        # conversation turn (tool calls, tool results, and final response).
        messages_chain = subtask.result.get("messages_chain")
        if messages_chain and isinstance(messages_chain, list):
            # Attach loaded_skills to the last assistant message in the chain
            loaded_skills = subtask.result.get("loaded_skills")
            if loaded_skills:
                for msg in reversed(messages_chain):
                    if msg.get("role") == "assistant":
                        msg["loaded_skills"] = loaded_skills
                        break
            return messages_chain

        # Fallback for legacy data without messages_chain
        content = subtask.result.get("value", "")
        if not content:
            return []

        msg: dict[str, Any] = {"role": "assistant", "content": content}

        # Include loaded_skills for skill state restoration across conversation turns
        loaded_skills = subtask.result.get("loaded_skills")
        if loaded_skills:
            msg["loaded_skills"] = loaded_skills

        return [msg]

    return []


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
    type_data = getattr(context, "type_data", None) or {}
    rag_result = type_data.get("rag_result") or {}
    if rag_result.get("restricted_mode") or type_data.get("restricted_mode"):
        logger.info(
            "[history] Skipping restricted knowledge base context: id=%s, kb_id=%s",
            getattr(context, "id", None),
            getattr(context, "knowledge_id", None),
        )
        return ""

    if not context.extracted_text:
        return ""

    kb_name = context.name or "Knowledge Base"
    kb_id = context.knowledge_id or "unknown"
    return f"[Knowledge Base: {kb_name} (ID: {kb_id})]\n{context.extracted_text}\n\n"


def _truncate_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Truncate chat history keeping first N and last M messages.

    This is used for group chat to reduce prompt length while retaining
    the start of the conversation and the most recent context.

    Tool-call groups (assistant with ``tool_calls`` + tool responses) are
    treated as atomic units so that truncation never splits a group.
    The actual number of messages kept may slightly exceed ``first_n + last_n``
    to preserve group integrity.
    """

    first_n = settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES
    last_n = settings.GROUP_CHAT_HISTORY_LAST_MESSAGES

    # Handle edge case where both values are 0 or negative
    if first_n <= 0 and last_n <= 0:
        return history

    if len(history) <= first_n + last_n:
        return history

    groups = _group_messages(history)

    # Determine which groups to keep from the head (first_n messages)
    head_count = 0
    head_groups = 0
    for g in groups:
        if head_count >= first_n:
            break
        head_count += len(g)
        head_groups += 1

    # Determine which groups to keep from the tail (last_n messages)
    tail_count = 0
    tail_groups = 0
    for g in reversed(groups):
        if tail_count >= last_n:
            break
        tail_count += len(g)
        tail_groups += 1

    # If head + tail covers all groups, return as-is
    if head_groups + tail_groups >= len(groups):
        return history

    head = groups[:head_groups]
    tail = groups[len(groups) - tail_groups :] if tail_groups > 0 else []

    result: list[dict[str, Any]] = []
    for g in [*head, *tail]:
        result.extend(g)
    return result
