# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal Chat Storage API endpoints.

Provides internal API for chat_shell's RemoteStore to access chat history.
These endpoints are intended for service-to-service communication, not user access.

Authentication:
- Uses Internal Service Token (X-Service-Name header)
- In production, should be protected by network-level security
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["internal-chat"])


# ==================== Request/Response Schemas ====================


class MessageCreate(BaseModel):
    """Schema for creating a message."""

    role: str = Field(..., description="Message role: user, assistant, system, tool")
    content: Any = Field(
        ..., description="Message content (string or list for multimodal)"
    )
    name: Optional[str] = Field(None, description="Name for tool messages")
    tool_call_id: Optional[str] = Field(
        None, description="Tool call ID for tool messages"
    )
    tool_calls: Optional[list] = Field(
        None, description="Tool calls for assistant messages"
    )
    metadata: Optional[dict] = Field(None, description="Additional metadata")


class MessageUpdate(BaseModel):
    """Schema for updating a message."""

    content: Any = Field(..., description="New message content")


class BatchMessagesCreate(BaseModel):
    """Schema for batch creating messages."""

    messages: list[MessageCreate]


class MessageResponse(BaseModel):
    """Response schema for a single message."""

    id: str
    role: str
    content: Any
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[list] = None
    created_at: Optional[str] = None


class HistoryResponse(BaseModel):
    """Response schema for chat history."""

    session_id: str
    messages: list[MessageResponse]


class SessionListResponse(BaseModel):
    """Response schema for session list."""

    sessions: list[str]


class SuccessResponse(BaseModel):
    """Generic success response."""

    success: bool


class MessageIdResponse(BaseModel):
    """Response with message ID."""

    message_id: str


class BatchMessageIdsResponse(BaseModel):
    """Response with multiple message IDs."""

    message_ids: list[str]


class ToolResultCreate(BaseModel):
    """Schema for saving tool result."""

    tool_call_id: str
    result: Any
    ttl: Optional[int] = None


class ToolCallCreate(BaseModel):
    """Schema for pending tool call."""

    id: str
    name: str
    input: dict


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    service: str = "internal-chat-storage"


# ==================== Helper Functions ====================


def parse_session_id(session_id: str) -> tuple[str, int]:
    """
    Parse session_id to extract type and ID.

    Session ID format: "task-{task_id}" or "subtask-{subtask_id}"

    Returns:
        tuple of (type, id) where type is "task" or "subtask"

    Raises:
        HTTPException if format is invalid
    """
    parts = session_id.split("-", 1)
    if len(parts) != 2:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid session_id format: {session_id}. Expected 'task-{{id}}' or 'subtask-{{id}}'",
        )

    session_type, id_str = parts
    if session_type not in ("task", "subtask"):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid session type: {session_type}. Expected 'task' or 'subtask'",
        )

    try:
        session_id_int = int(id_str)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid session ID: {id_str}. Expected integer",
        )

    return session_type, session_id_int


def subtask_to_message(
    subtask: Subtask, db: Session, is_group_chat: bool = False
) -> MessageResponse:
    """Convert Subtask ORM object to MessageResponse with full context loading.

    For user messages, this function:
    1. Loads all contexts (attachments and knowledge_base) in one query
    2. Processes attachments first (images or text) - they have priority
    3. Processes knowledge_base contexts with remaining token space
    4. Follows MAX_EXTRACTED_TEXT_LENGTH limit with attachments having priority
    """
    role = "user" if subtask.role == SubtaskRole.USER else "assistant"

    # Extract content based on role
    if subtask.role == SubtaskRole.USER:
        # Get sender username for group chat
        sender_username = None
        if is_group_chat and subtask.sender_user_id:
            user = db.query(User).filter(User.id == subtask.sender_user_id).first()
            if user:
                sender_username = user.user_name

        # Build content with context (attachments and knowledge bases)
        content = _build_user_message_content(
            db, subtask, sender_username, is_group_chat
        )
    else:
        # For assistant, content is in result.value
        if subtask.result and isinstance(subtask.result, dict):
            content = subtask.result.get("value", "")
        else:
            content = ""

    return MessageResponse(
        id=str(subtask.id),
        role=role,
        content=content,
        created_at=subtask.created_at.isoformat() if subtask.created_at else None,
    )


def _build_user_message_content(
    db: Session,
    subtask: Subtask,
    sender_username: str | None,
    is_group_chat: bool = False,
) -> Any:
    """Build user message content with attachments and knowledge base contexts.

    Returns either a string or a list of content blocks (for multimodal messages).
    """
    import base64

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
        return text_content

    # Separate contexts by type
    attachments = [
        c for c in all_contexts if c.context_type == ContextType.ATTACHMENT.value
    ]
    kb_contexts = [
        c for c in all_contexts if c.context_type == ContextType.KNOWLEDGE_BASE.value
    ]

    # Process attachments first (they have priority)
    vision_parts: list[dict[str, Any]] = []
    attachment_text_parts: list[str] = []
    total_attachment_text_length = 0

    for attachment in attachments:
        # Check if it's an image
        if attachment.mime_type and attachment.mime_type.startswith("image/"):
            # Use stored image_base64 if available (preferred, already decoded)
            # This is generated at upload time from the original unencrypted binary data
            if attachment.image_base64:
                vision_parts.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{attachment.mime_type};base64,{attachment.image_base64}",
                        },
                    }
                )
                logger.debug(
                    f"[history] Loaded image attachment from image_base64: id={attachment.id}, "
                    f"name={attachment.name}, mime_type={attachment.mime_type}"
                )
        else:
            # Document attachment
            if attachment.extracted_text:
                doc_prefix = f"[Document: {attachment.name or 'document'}]\n{attachment.extracted_text}\n\n"
                attachment_text_parts.append(doc_prefix)
                total_attachment_text_length += len(doc_prefix)
                logger.debug(
                    f"[history] Loaded attachment: id={attachment.id}, "
                    f"name={attachment.name}, text_len={len(attachment.extracted_text)}"
                )

    # Calculate remaining token space for knowledge base content
    max_text_length = getattr(settings, "MAX_EXTRACTED_TEXT_LENGTH", 100000)
    remaining_space = max_text_length - total_attachment_text_length

    # Process knowledge base contexts with remaining space
    kb_text_parts: list[str] = []
    current_kb_length = 0

    for kb_ctx in kb_contexts:
        if remaining_space <= 0:
            logger.debug(f"No remaining space for knowledge base context {kb_ctx.id}")
            break

        if kb_ctx.extracted_text:
            kb_name = kb_ctx.name or "Knowledge Base"
            kb_id = kb_ctx.knowledge_id or "unknown"
            kb_prefix = f"[Knowledge Base: {kb_name} (ID: {kb_id})]\n{kb_ctx.extracted_text}\n\n"

            prefix_length = len(kb_prefix)
            if current_kb_length + prefix_length <= remaining_space:
                kb_text_parts.append(kb_prefix)
                current_kb_length += prefix_length
                logger.debug(
                    f"[history] Loaded knowledge base: id={kb_ctx.id}, "
                    f"name={kb_ctx.name}, kb_id={kb_id}"
                )
            else:
                # Truncate if partial space available
                available = remaining_space - current_kb_length
                if available > 100:  # Only include if meaningful content remains
                    truncated_prefix = kb_prefix[:available] + "\n(truncated...)\n\n"
                    kb_text_parts.append(truncated_prefix)
                    logger.debug(
                        f"[history] Loaded knowledge base (truncated): id={kb_ctx.id}, "
                        f"name={kb_ctx.name}, truncated_to={available} chars"
                    )
                break

    # Combine all text parts: attachments first, then knowledge bases
    all_text_parts = attachment_text_parts + kb_text_parts
    if all_text_parts:
        combined_prefix = "".join(all_text_parts)
        text_content = f"{combined_prefix}{text_content}"

    # Return multimodal content if we have vision parts
    if vision_parts:
        return [{"type": "text", "text": text_content}, *vision_parts]

    return text_content


# ==================== API Endpoints ====================


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint for internal chat storage API."""
    return HealthResponse(status="ok")


@router.get("/history/{session_id}", response_model=HistoryResponse)
async def get_chat_history(
    session_id: str,
    limit: Optional[int] = Query(None, description="Max number of messages to return"),
    before_message_id: Optional[int] = Query(
        None, description="Only return messages before this ID"
    ),
    is_group_chat: bool = Query(False, description="Whether this is a group chat"),
    db: Session = Depends(get_db),
):
    """
    Get chat history for a session.

    The session_id format is "task-{task_id}" for task-based sessions.

    Returns messages in chronological order (oldest first).
    For user messages, also loads associated contexts (attachments, knowledge bases).
    """
    session_type, task_id = parse_session_id(session_id)

    if session_type != "task":
        raise HTTPException(
            status_code=400,
            detail="Only task-based sessions are supported",
        )

    # Build query for subtasks - only get COMPLETED messages for history
    # This matches the behavior in backup version (loader.py:75-78)
    query = db.query(Subtask).filter(
        Subtask.task_id == task_id,
        Subtask.status == SubtaskStatus.COMPLETED,
    )

    if before_message_id:
        # Filter by message_id, not subtask.id
        # message_id represents the order within the conversation
        query = query.filter(Subtask.message_id < before_message_id)

    # Order by message_id (chronological) instead of id
    query = query.order_by(Subtask.message_id.asc())

    if limit:
        query = query.limit(limit)

    subtasks = query.all()

    # Convert to message format with full context loading
    messages = [subtask_to_message(st, db, is_group_chat) for st in subtasks]

    logger.debug(
        "get_chat_history: session_id=%s, count=%d, is_group_chat=%s",
        session_id,
        len(messages),
        is_group_chat,
    )

    return HistoryResponse(session_id=session_id, messages=messages)


@router.post("/history/{session_id}/messages", response_model=MessageIdResponse)
async def append_message(
    session_id: str,
    message: MessageCreate,
    db: Session = Depends(get_db),
):
    """
    Append a message to session history.

    Creates a new Subtask record for the message.
    """
    session_type, task_id = parse_session_id(session_id)

    if session_type != "task":
        raise HTTPException(
            status_code=400,
            detail="Only task-based sessions are supported",
        )

    # Get task info to determine team_id
    existing = db.query(Subtask).filter(Subtask.task_id == task_id).first()
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"No subtasks found for task {task_id}",
        )

    # Determine role
    if message.role == "user":
        role = SubtaskRole.USER
    else:
        role = SubtaskRole.ASSISTANT

    # Get next message_id
    max_message_id = (
        db.query(Subtask.message_id)
        .filter(Subtask.task_id == task_id)
        .order_by(Subtask.message_id.desc())
        .first()
    )
    next_message_id = (max_message_id[0] + 1) if max_message_id else 1

    # Create subtask
    subtask = Subtask(
        task_id=task_id,
        team_id=existing.team_id,
        user_id=existing.user_id,
        title="",
        bot_ids=existing.bot_ids,
        role=role,
        message_id=next_message_id,
        status=SubtaskStatus.COMPLETED,
    )

    # Set content based on role
    if role == SubtaskRole.USER:
        subtask.prompt = (
            message.content
            if isinstance(message.content, str)
            else str(message.content)
        )
    else:
        subtask.result = {
            "value": (
                message.content
                if isinstance(message.content, str)
                else str(message.content)
            )
        }

    db.add(subtask)
    db.commit()
    db.refresh(subtask)

    logger.debug(
        "append_message: session_id=%s, message_id=%d, role=%s",
        session_id,
        subtask.id,
        message.role,
    )

    return MessageIdResponse(message_id=str(subtask.id))


@router.post(
    "/history/{session_id}/messages/batch", response_model=BatchMessageIdsResponse
)
async def append_messages_batch(
    session_id: str,
    batch: BatchMessagesCreate,
    db: Session = Depends(get_db),
):
    """
    Batch append messages to session history.
    """
    session_type, task_id = parse_session_id(session_id)

    if session_type != "task":
        raise HTTPException(
            status_code=400,
            detail="Only task-based sessions are supported",
        )

    # Get task info
    existing = db.query(Subtask).filter(Subtask.task_id == task_id).first()
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"No subtasks found for task {task_id}",
        )

    # Get next message_id
    max_message_id = (
        db.query(Subtask.message_id)
        .filter(Subtask.task_id == task_id)
        .order_by(Subtask.message_id.desc())
        .first()
    )
    next_message_id = (max_message_id[0] + 1) if max_message_id else 1

    message_ids = []
    for message in batch.messages:
        role = SubtaskRole.USER if message.role == "user" else SubtaskRole.ASSISTANT

        subtask = Subtask(
            task_id=task_id,
            team_id=existing.team_id,
            user_id=existing.user_id,
            title="",
            bot_ids=existing.bot_ids,
            role=role,
            message_id=next_message_id,
            status=SubtaskStatus.COMPLETED,
        )

        if role == SubtaskRole.USER:
            subtask.prompt = (
                message.content
                if isinstance(message.content, str)
                else str(message.content)
            )
        else:
            subtask.result = {
                "value": (
                    message.content
                    if isinstance(message.content, str)
                    else str(message.content)
                )
            }

        db.add(subtask)
        db.flush()  # Get ID without committing
        message_ids.append(str(subtask.id))
        next_message_id += 1

    db.commit()

    logger.debug(
        "append_messages_batch: session_id=%s, count=%d",
        session_id,
        len(message_ids),
    )

    return BatchMessageIdsResponse(message_ids=message_ids)


@router.patch(
    "/history/{session_id}/messages/{message_id}", response_model=SuccessResponse
)
async def update_message(
    session_id: str,
    message_id: str,
    update: MessageUpdate,
    db: Session = Depends(get_db),
):
    """
    Update message content (typically for streaming scenarios).
    """
    try:
        subtask_id = int(message_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid message_id")

    subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
    if not subtask:
        raise HTTPException(status_code=404, detail="Message not found")

    # Update content based on role
    if subtask.role == SubtaskRole.USER:
        subtask.prompt = (
            update.content if isinstance(update.content, str) else str(update.content)
        )
    else:
        subtask.result = {
            "value": (
                update.content
                if isinstance(update.content, str)
                else str(update.content)
            )
        }

    db.commit()

    logger.debug(
        "update_message: session_id=%s, message_id=%s",
        session_id,
        message_id,
    )

    return SuccessResponse(success=True)


@router.delete(
    "/history/{session_id}/messages/{message_id}", response_model=SuccessResponse
)
async def delete_message(
    session_id: str,
    message_id: str,
    db: Session = Depends(get_db),
):
    """
    Delete a message (soft delete by setting status to DELETE).
    """
    try:
        subtask_id = int(message_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid message_id")

    subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
    if not subtask:
        raise HTTPException(status_code=404, detail="Message not found")

    subtask.status = SubtaskStatus.DELETE
    db.commit()

    logger.debug(
        "delete_message: session_id=%s, message_id=%s",
        session_id,
        message_id,
    )

    return SuccessResponse(success=True)


@router.delete("/history/{session_id}", response_model=SuccessResponse)
async def clear_history(
    session_id: str,
    db: Session = Depends(get_db),
):
    """
    Clear all history for a session (soft delete all subtasks).
    """
    session_type, task_id = parse_session_id(session_id)

    if session_type != "task":
        raise HTTPException(
            status_code=400,
            detail="Only task-based sessions are supported",
        )

    # Soft delete all subtasks for this task
    db.query(Subtask).filter(Subtask.task_id == task_id).update(
        {"status": SubtaskStatus.DELETE}
    )
    db.commit()

    logger.debug("clear_history: session_id=%s", session_id)

    return SuccessResponse(success=True)


@router.get("/sessions", response_model=SessionListResponse)
async def list_sessions(
    limit: int = Query(100, description="Max number of sessions to return"),
    offset: int = Query(0, description="Offset for pagination"),
    db: Session = Depends(get_db),
):
    """
    List all session IDs (unique task IDs with subtasks).

    Note: This is primarily for CLI/testing. In production, sessions are
    typically managed by task_id which comes from the frontend.
    """
    # Get unique task_ids with subtasks, ordered by most recent activity
    from sqlalchemy import func

    task_ids = (
        db.query(Subtask.task_id)
        .filter(Subtask.status != SubtaskStatus.DELETE)
        .group_by(Subtask.task_id)
        .order_by(func.max(Subtask.id).desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    sessions = [f"task-{task_id[0]}" for task_id in task_ids]

    return SessionListResponse(sessions=sessions)


# ==================== Tool Result Endpoints (Optional) ====================


@router.post("/tool-results/{session_id}", response_model=SuccessResponse)
async def save_tool_result(
    session_id: str,
    data: ToolResultCreate,
    db: Session = Depends(get_db),
):
    """
    Save tool execution result.

    Note: Tool results are typically stored in Redis for fast access.
    This endpoint provides a DB-backed alternative for persistence.
    """
    # For now, tool results are stored in the session manager's Redis cache
    # This endpoint is a placeholder for future DB-backed storage
    from app.services.chat.storage import session_manager

    session_type, task_id = parse_session_id(session_id)
    cache_key = f"tool_result:{task_id}:{data.tool_call_id}"

    await session_manager._cache.set(
        cache_key,
        data.result,
        expire=data.ttl or 3600,  # Default 1 hour
    )

    return SuccessResponse(success=True)


@router.get("/tool-results/{session_id}/{tool_call_id}")
async def get_tool_result(
    session_id: str,
    tool_call_id: str,
    db: Session = Depends(get_db),
):
    """Get tool execution result."""
    from app.services.chat.storage import session_manager

    session_type, task_id = parse_session_id(session_id)
    cache_key = f"tool_result:{task_id}:{tool_call_id}"

    result = await session_manager._cache.get(cache_key)
    if result is None:
        raise HTTPException(status_code=404, detail="Tool result not found")

    return {"result": result}


@router.get("/pending-tool-calls/{session_id}")
async def get_pending_tool_calls(
    session_id: str,
    db: Session = Depends(get_db),
):
    """Get pending tool calls for a session."""
    from app.services.chat.storage import session_manager

    session_type, task_id = parse_session_id(session_id)
    cache_key = f"pending_tool_calls:{task_id}"

    tool_calls = await session_manager._cache.get(cache_key)

    return {"tool_calls": tool_calls or []}


@router.post("/pending-tool-calls/{session_id}", response_model=SuccessResponse)
async def save_pending_tool_call(
    session_id: str,
    tool_call: ToolCallCreate,
    db: Session = Depends(get_db),
):
    """Save a pending tool call."""
    from app.services.chat.storage import session_manager

    session_type, task_id = parse_session_id(session_id)
    cache_key = f"pending_tool_calls:{task_id}"

    # Get existing pending calls
    existing = await session_manager._cache.get(cache_key) or []
    existing.append(tool_call.model_dump())

    await session_manager._cache.set(cache_key, existing, expire=3600)

    return SuccessResponse(success=True)


@router.delete("/pending-tool-calls/{session_id}", response_model=SuccessResponse)
async def clear_pending_tool_calls(
    session_id: str,
    db: Session = Depends(get_db),
):
    """Clear pending tool calls for a session."""
    from app.services.chat.storage import session_manager

    session_type, task_id = parse_session_id(session_id)
    cache_key = f"pending_tool_calls:{task_id}"

    await session_manager._cache.delete(cache_key)

    return SuccessResponse(success=True)
