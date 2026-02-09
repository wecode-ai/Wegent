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
from app.models.knowledge import KnowledgeDocument
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import (
    ContextStatus,
    ContextType,
    InjectionMode,
    SubtaskContext,
)
from app.models.user import User
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["internal-chat"])

# Knowledge base injection mode constant for kb_head (not in enum as it's tool-specific)
INJECTION_MODE_KB_HEAD = "kb_head"


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
    loaded_skills: Optional[list[str]] = None  # Skills loaded in this message turn


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

    For assistant messages, this function also extracts:
    - loaded_skills: List of skills loaded via load_skill tool in this turn
    """
    role = "user" if subtask.role == SubtaskRole.USER else "assistant"
    loaded_skills = None

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
            # Extract loaded_skills for skill state restoration across conversation turns
            loaded_skills = subtask.result.get("loaded_skills")
        else:
            content = ""

    return MessageResponse(
        id=str(subtask.id),
        role=role,
        content=content,
        created_at=subtask.created_at.isoformat() if subtask.created_at else None,
        loaded_skills=loaded_skills,
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

    from app.services.context import context_service

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

    for idx, attachment in enumerate(attachments, start=1):
        # Check if it's an image
        if context_service.is_image_context(attachment) and attachment.image_base64:
            # Build image attachment metadata header
            attachment_id = attachment.id
            filename = attachment.original_filename or attachment.name
            mime_type = attachment.mime_type or "unknown"
            file_size = attachment.file_size or 0
            formatted_size = context_service.format_file_size(file_size)
            url = context_service.build_attachment_url(attachment_id)

            # Build image metadata header
            image_header = (
                f"[Image Attachment: {filename} | ID: {attachment_id} | "
                f"Type: {mime_type} | Size: {formatted_size} | URL: {url}]"
            )

            # Add text header to content
            attachment_text_parts.append(f"{image_header}\n")
            total_attachment_text_length += len(image_header) + 1

            # Add vision part for image rendering
            vision_parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime_type};base64,{attachment.image_base64}",
                    },
                }
            )
            logger.debug(
                f"[history] Loaded image attachment with metadata: id={attachment.id}, "
                f"name={filename}, mime_type={mime_type}"
            )
        else:
            # Document attachment - use context_service to build metadata-rich prefix
            doc_prefix = context_service.build_document_text_prefix(attachment)
            if doc_prefix:
                attachment_text_parts.append(doc_prefix)
                total_attachment_text_length += len(doc_prefix)
                logger.debug(
                    f"[history] Loaded document attachment with metadata: id={attachment.id}, "
                    f"name={attachment.name}, text_len={len(attachment.extracted_text or '')}"
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

        # Get content from extracted_text or fetch from documents for injection modes
        kb_content = kb_ctx.extracted_text
        if not kb_content:
            # Check if this is direct_injection or kb_head mode - need to load from documents
            type_data = kb_ctx.type_data or {}
            knowledge_id = type_data.get("knowledge_id")

            # Try rag_result sub-object first, then fall back to flat field
            rag_result = type_data.get("rag_result", {})
            injection_mode = rag_result.get("injection_mode") or type_data.get(
                "injection_mode"
            )

            # Try kb_head_result sub-object
            kb_head_result = type_data.get("kb_head_result", {})
            kb_head_document_ids = kb_head_result.get("document_ids", [])
            kb_head_offset = kb_head_result.get("offset", 0)
            kb_head_limit = kb_head_result.get("limit", 50000)

            if injection_mode == InjectionMode.DIRECT_INJECTION.value and knowledge_id:
                logger.debug(
                    f"[history] Loading documents for direct_injection KB: "
                    f"id={kb_ctx.id}, kb_id={knowledge_id}"
                )
                kb_content = _fetch_kb_documents_content(db, knowledge_id)
            elif kb_head_document_ids:
                # kb_head mode: load specific documents by IDs
                logger.debug(
                    f"[history] Loading documents for kb_head: "
                    f"id={kb_ctx.id}, document_ids={kb_head_document_ids}, "
                    f"offset={kb_head_offset}, limit={kb_head_limit}"
                )
                kb_content = _fetch_kb_head_documents_content(
                    db, kb_head_document_ids, kb_head_offset, kb_head_limit
                )

        if kb_content:
            kb_name = kb_ctx.name or "Knowledge Base"
            kb_id = kb_ctx.knowledge_id or "unknown"
            kb_prefix = f"[Knowledge Base: {kb_name} (ID: {kb_id})]\n{kb_content}\n\n"

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

    # Combine text parts with proper XML tags
    # For vision parts (images), attachment_text_parts contains image metadata headers
    # which need to be wrapped in <attachment> tags for consistency with first upload
    if vision_parts:
        # Image attachments: wrap metadata headers in <attachment> tag
        combined_prefix = ""
        if attachment_text_parts:
            headers_text = "\n\n".join(attachment_text_parts)
            combined_prefix += f"<attachment>\n\n{headers_text}\n</attachment>\n\n"
        if kb_text_parts:
            combined_prefix += (
                "<knowledge_base>\n\n"
                + "\n\n".join(kb_text_parts)
                + "</knowledge_base>\n\n"
            )
        if combined_prefix:
            text_content = f"{combined_prefix}{text_content}"
        return [{"type": "text", "text": text_content}, *vision_parts]

    # Non-image attachments: wrap in <attachment> tag, knowledge bases in <knowledge_base> tag
    combined_prefix = ""
    if attachment_text_parts:
        combined_prefix += (
            "<attachment>" + "\n\n".join(attachment_text_parts) + "</attachment>\n\n"
        )
    if kb_text_parts:
        combined_prefix += (
            "<knowledge_base>" + "\n\n".join(kb_text_parts) + "</knowledge_base>\n\n"
        )
    if combined_prefix:
        text_content = f"{combined_prefix}{text_content}"

    return text_content


@trace_sync(
    span_name="fetch_kb_documents_content",
    tracer_name="internal.chat_storage",
)
def _fetch_kb_documents_content(
    db: Session,
    knowledge_id: int,
) -> str:
    """
    Fetch all document content from a knowledge base for direct injection mode.

    When a knowledge_base context uses direct_injection mode, extracted_text is empty
    to save storage space. This function loads content from the original documents:
    KnowledgeDocument.attachment_id → SubtaskContext (ATTACHMENT type) → extracted_text

    Args:
        db: Database session
        knowledge_id: Knowledge base ID (Kind.id)

    Returns:
        Concatenated text content from all active documents
    """
    # Query all active documents in this knowledge base
    documents = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.kind_id == knowledge_id,
            KnowledgeDocument.is_active.is_(True),
            KnowledgeDocument.attachment_id > 0,
        )
        .order_by(KnowledgeDocument.created_at)
        .all()
    )

    if not documents:
        logger.debug(
            f"[_fetch_kb_documents_content] No active documents found for kb_id={knowledge_id}"
        )
        return ""

    # Collect attachment IDs
    attachment_ids = [doc.attachment_id for doc in documents]

    # Query attachment contexts to get extracted_text
    attachment_contexts = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(attachment_ids),
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            SubtaskContext.status == ContextStatus.READY.value,
        )
        .all()
    )

    # Build attachment_id -> extracted_text mapping
    attachment_text_map = {
        ctx.id: ctx.extracted_text for ctx in attachment_contexts if ctx.extracted_text
    }

    # Build document content
    content_parts = []
    for doc in documents:
        if doc.attachment_id in attachment_text_map:
            text = attachment_text_map[doc.attachment_id]
            doc_header = f"## Document: {doc.name}"
            if doc.file_extension:
                doc_header += f" ({doc.file_extension})"
            content_parts.append(f"{doc_header}\n\n{text}")

    if content_parts:
        logger.debug(
            f"[_fetch_kb_documents_content] Loaded {len(content_parts)} documents "
            f"for kb_id={knowledge_id}, total_chars={sum(len(p) for p in content_parts)}"
        )

    return "\n\n".join(content_parts)


@trace_sync(
    span_name="fetch_kb_head_documents_content",
    tracer_name="internal.chat_storage",
)
def _fetch_kb_head_documents_content(
    db: Session,
    document_ids: list[int],
    offset: int = 0,
    limit: int = 50000,
) -> str:
    """
    Fetch document content for kb_head cross-turn injection.

    When a knowledge_base context uses kb_head tool, extracted_text may be empty
    to save storage space. This function loads content from the specified documents
    using the stored document_ids, offset, and limit parameters.

    The offset and limit are applied to each document's content to match the
    original kb_head tool behavior.

    Args:
        db: Database session
        document_ids: List of KnowledgeDocument IDs to load
        offset: Character offset for content extraction
        limit: Maximum characters to return per document

    Returns:
        Concatenated text content from specified documents (with offset/limit applied)
    """
    if not document_ids:
        return ""

    # Query documents by IDs (without ordering, we'll preserve input order)
    # NOTE: kb_head tool (`/api/internal/rag/read-doc`) does NOT require is_active=True.
    # Cross-turn injection should match tool behavior; otherwise documents that are not
    # indexed yet (is_active=False) will never be injected from history.
    documents = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id.in_(document_ids),
            KnowledgeDocument.attachment_id > 0,
        )
        .all()
    )

    if not documents:
        return ""

    # Build document_id -> document mapping for order preservation
    documents_by_id = {doc.id: doc for doc in documents}

    # Collect attachment IDs (preserving input order)
    attachment_ids = [
        documents_by_id[doc_id].attachment_id
        for doc_id in document_ids
        if doc_id in documents_by_id
    ]

    # Query attachment contexts to get extracted_text
    attachment_contexts = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(attachment_ids),
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            SubtaskContext.status == ContextStatus.READY.value,
        )
        .all()
    )

    # Build attachment_id -> extracted_text mapping
    attachment_text_map = {
        ctx.id: ctx.extracted_text for ctx in attachment_contexts if ctx.extracted_text
    }

    # Build document content with offset/limit applied (preserving input order)
    content_parts = []
    for doc_id in document_ids:
        if doc_id not in documents_by_id:
            continue
        doc = documents_by_id[doc_id]
        if doc.attachment_id in attachment_text_map:
            full_text = attachment_text_map[doc.attachment_id]
            # Apply offset and limit to match original kb_head read behavior
            start = min(offset, len(full_text))
            end = min(start + limit, len(full_text))
            text = full_text[start:end]

            doc_header = f"## Document: {doc.name}"
            if doc.file_extension:
                doc_header += f" ({doc.file_extension})"
            content_parts.append(f"{doc_header}\n\n{text}")

    if content_parts:
        logger.debug(
            f"[_fetch_kb_head_documents_content] Loaded {len(content_parts)} documents "
            f"for document_ids={document_ids}, offset={offset}, limit={limit}, "
            f"total_chars={sum(len(p) for p in content_parts)}"
        )

    return "\n\n".join(content_parts)


# ==================== API Endpoints ====================


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint for internal chat storage API."""
    return HealthResponse(status="ok")


@router.get("/history/{session_id}", response_model=HistoryResponse)
async def get_chat_history(
    session_id: str,
    limit: Optional[int] = Query(
        None, description="Max number of messages to return (most recent N messages)"
    ),
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

    When limit is specified, returns the most recent N messages (not the oldest N).
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

    # When limit is specified, we need to get the most recent N messages
    # First order by message_id desc to get the latest, then reverse
    if limit:
        subtasks = query.order_by(Subtask.message_id.desc()).limit(limit).all()
        # Reverse to get chronological order (oldest first)
        subtasks = list(reversed(subtasks))
    else:
        # No limit - get all messages in chronological order
        subtasks = query.order_by(Subtask.message_id.asc()).all()

    # Convert to message format with full context loading
    messages = [subtask_to_message(st, db, is_group_chat) for st in subtasks]

    logger.debug(
        "get_chat_history: session_id=%s, count=%d, is_group_chat=%s, limit=%s",
        session_id,
        len(messages),
        is_group_chat,
        limit,
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
