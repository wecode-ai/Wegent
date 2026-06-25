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

import json
import logging
from datetime import datetime
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
from app.services.chat.guidance_queue import guidance_queue
from app.services.chat.webpage_ws_chat_emitter import get_webpage_ws_emitter
from app.services.task_fork_history import task_fork_history_resolver
from app.stores.tasks import subtask_store, task_store
from shared.prompts.constants import parse_prompt_blocks
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["internal-chat"])

# Knowledge base injection mode constant for kb_head (not in enum as it's tool-specific)
INJECTION_MODE_KB_HEAD = "kb_head"

# Hard upper bound for a single attachment-text slice (characters). read_attachment
# is a paginated reader; a page is token-clamped by the caller anyway, so there is
# no legitimate reason to request a huge slice. This is HTTP-layer defense-in-depth:
# the caller's real page window is page_token_limit * chars-per-token (~60K today),
# so this sits just above it. Raise it if that page window grows.
MAX_ATTACHMENT_TEXT_SLICE = 64_000


def _is_restricted_kb_context(kb_ctx: SubtaskContext) -> bool:
    """Whether a KB history context should be suppressed for restricted mode."""
    type_data = kb_ctx.type_data or {}
    rag_result = type_data.get("rag_result") or {}
    return bool(rag_result.get("restricted_mode") or type_data.get("restricted_mode"))


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
    model_info: Optional[dict] = Field(
        None, description="Provider/model metadata for think-block filtering"
    )


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
    reasoning_content: Any | None = None
    created_at: Optional[str] = None
    loaded_skills: Optional[list[str]] = None  # Skills loaded in this message turn
    model_info: Optional[dict] = (
        None  # Provider/model metadata for think-block filtering
    )


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


class GuidanceConsumeResponse(BaseModel):
    """Response for guidance consume endpoint."""

    item: Optional[dict] = None


class GuidanceExpireResponse(BaseModel):
    """Response for guidance expire endpoint."""

    expired_ids: list[str] = Field(default_factory=list)


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


def subtask_to_messages(
    subtask: Subtask, db: Session, is_group_chat: bool = False
) -> list[MessageResponse]:
    """Convert Subtask ORM object to a list of MessageResponse objects.

    Returns a list because a single assistant subtask may expand into multiple
    messages when ``messages_chain`` is present (intermediate tool call / tool
    result messages from a single agent turn).

    For user messages, this function:
    1. Loads all contexts (attachments and knowledge_base) in one query
    2. Processes attachments first (images or text) - they have priority
    3. Processes knowledge_base contexts with remaining token space
    4. Follows MAX_EXTRACTED_TEXT_LENGTH limit with attachments having priority

    For assistant messages, this function also extracts:
    - loaded_skills: List of skills loaded via load_skill tool in this turn
    """
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
        return [
            MessageResponse(
                id=str(subtask.id),
                role="user",
                content=content,
                created_at=(
                    subtask.created_at.isoformat() if subtask.created_at else None
                ),
            )
        ]

    # Assistant messages ---------------------------------------------------
    # For FAILED assistant subtasks, only keep result.value when present.
    # Do not expand messages_chain for failed turns to avoid injecting
    # tool-call artifacts or partial chain state into model history.
    if subtask.status == SubtaskStatus.FAILED:
        if subtask.role != SubtaskRole.ASSISTANT:
            return []
        result = subtask.result if isinstance(subtask.result, dict) else {}
        content = result.get("value", "")
        if not content:
            return []
        return [
            MessageResponse(
                id=str(subtask.id),
                role="assistant",
                content=content,
                created_at=(
                    subtask.created_at.isoformat() if subtask.created_at else None
                ),
            )
        ]

    result = subtask.result if isinstance(subtask.result, dict) else {}
    created_at = subtask.created_at.isoformat() if subtask.created_at else None

    # If messages_chain is available, expand to individual MessageResponse objects
    messages_chain = result.get("messages_chain")
    if messages_chain and isinstance(messages_chain, list):
        loaded_skills = result.get("loaded_skills")
        responses: list[MessageResponse] = []
        for idx, msg in enumerate(messages_chain):
            msg_id = f"{subtask.id}-{idx}"
            role = msg.get("role", "assistant")
            resp = MessageResponse(
                id=msg_id,
                role=role,
                content=msg.get("content", ""),
                name=msg.get("name"),
                tool_call_id=msg.get("tool_call_id"),
                tool_calls=msg.get("tool_calls"),
                reasoning_content=msg.get("reasoning_content"),
                created_at=created_at,
                model_info=msg.get("model_info"),
            )
            responses.append(resp)
        # Attach loaded_skills to the last *assistant* message in the chain,
        # mirroring the package-mode backward scan so that skill state is
        # restored even when the chain ends with a tool message.
        if loaded_skills:
            for resp in reversed(responses):
                if resp.role == "assistant":
                    resp.loaded_skills = loaded_skills
                    break
        return responses

    # Fallback for legacy data without messages_chain
    content = result.get("value", "")
    loaded_skills = result.get("loaded_skills")
    return [
        MessageResponse(
            id=str(subtask.id),
            role="assistant",
            content=content,
            created_at=created_at,
            loaded_skills=loaded_skills,
            model_info=result.get("model_info"),
        )
    ]


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

    # Build text content, handling both plain-text and JSON-array prompt formats.
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
        if extra_blocks:
            # New format: include stored system-reminder (carries time info
            # and any context metadata from the original send).
            return [{"type": "text", "text": text_content}, *extra_blocks]
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

        if _is_restricted_kb_context(kb_ctx):
            logger.info(
                "[history] Skipping restricted knowledge base context: id=%s, kb_id=%s",
                kb_ctx.id,
                kb_ctx.knowledge_id,
            )
            continue

        # Get content from extracted_text or fetch from documents for injection modes
        kb_content = kb_ctx.extracted_text
        if not kb_content:
            # Check if this is direct_injection or kb_head mode - need to load from documents
            type_data = kb_ctx.type_data or {}
            knowledge_id = type_data.get("knowledge_id")

            # Try rag_result sub-object first, then fall back to flat field
            # Use `or {}` pattern to handle None values (dict.get returns None if key exists with None value)
            rag_result = type_data.get("rag_result") or {}
            injection_mode = rag_result.get("injection_mode") or type_data.get(
                "injection_mode"
            )

            # Try kb_head_result sub-object
            kb_head_result = type_data.get("kb_head_result") or {}
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

    # Output assembly.
    #
    # This internal API serves chat_shell HTTP mode which sends the result
    # directly to the LLM.  The format must match what the LLM expects:
    #   [user_msg_block, image_blocks..., system_reminder_block]
    #
    # When extra_blocks is present (new format), the stored system-reminder
    # already contains all context metadata + time.  Pass it through as-is
    # to avoid duplication (the DB contexts are only needed for image base64).
    #
    # When extra_blocks is empty (old format), rebuild a system-reminder
    # from the DB context records.
    if extra_blocks:
        if vision_parts:
            return [
                {"type": "text", "text": text_content},
                *vision_parts,
                *extra_blocks,
            ]
        return [{"type": "text", "text": text_content}, *extra_blocks]

    # Old format fallback: rebuild system-reminder from DB context records.
    context_parts: list[str] = []
    if attachment_text_parts:
        context_parts.append(
            "<attachment>" + "".join(attachment_text_parts) + "</attachment>"
        )
    if kb_text_parts:
        context_parts.append(
            "<knowledge_base>" + "".join(kb_text_parts) + "</knowledge_base>"
        )

    if context_parts:
        inner = "".join(context_parts)
        reminder_block = {
            "type": "text",
            "text": f"<system-reminder>{inner}</system-reminder>",
        }
        if vision_parts:
            return [
                {"type": "text", "text": text_content},
                *vision_parts,
                reminder_block,
            ]
        return [{"type": "text", "text": text_content}, reminder_block]

    # No context at all
    if vision_parts:
        return [{"type": "text", "text": text_content}, *vision_parts]
    if is_structured_prompt:
        return [{"type": "text", "text": text_content}]
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


@router.post(
    "/guidance/{task_id}/{subtask_id}/consume",
    response_model=GuidanceConsumeResponse,
)
async def consume_guidance(task_id: int, subtask_id: int):
    """Consume the next queued Chat Shell guidance item."""
    logger.info(
        "[guidance] consume request: task_id=%s subtask_id=%s", task_id, subtask_id
    )
    item = await guidance_queue.consume(task_id=task_id, subtask_id=subtask_id)
    if item is None:
        logger.info(
            "[guidance] consume: no item in queue task_id=%s subtask_id=%s",
            task_id,
            subtask_id,
        )
        return GuidanceConsumeResponse(item=None)

    item_data = item.to_dict()
    applied_at = datetime.now().isoformat()
    ws_emitter = get_webpage_ws_emitter()
    logger.info(
        "[guidance] consumed item: task_id=%s subtask_id=%s guidance_id=%s ws_emitter=%s",
        task_id,
        subtask_id,
        item.guidance_id,
        ws_emitter is not None,
    )
    if ws_emitter:
        await ws_emitter.emit_guidance_applied(
            task_id=task_id,
            subtask_id=subtask_id,
            guidance_id=item.guidance_id,
            applied_at=applied_at,
        )
    return GuidanceConsumeResponse(item=item_data)


@router.post(
    "/guidance/{task_id}/{subtask_id}/expire",
    response_model=GuidanceExpireResponse,
)
async def expire_guidance(task_id: int, subtask_id: int):
    """Expire all queued Chat Shell guidance items."""
    expired_ids = await guidance_queue.expire(task_id=task_id, subtask_id=subtask_id)
    logger.info(
        "[guidance] expire: task_id=%s subtask_id=%s expired_ids=%s",
        task_id,
        subtask_id,
        expired_ids,
    )
    if expired_ids:
        ws_emitter = get_webpage_ws_emitter()
        if ws_emitter:
            await ws_emitter.emit_guidance_expired(
                task_id=task_id,
                subtask_id=subtask_id,
                guidance_ids=expired_ids,
            )
    return GuidanceExpireResponse(expired_ids=expired_ids)


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
    history_statuses = [
        SubtaskStatus.COMPLETED,
        SubtaskStatus.CANCELLED,
        SubtaskStatus.FAILED,
    ]

    if session_type != "task":
        raise HTTPException(
            status_code=400,
            detail="Only task-based sessions are supported",
        )

    logger.info(
        "get_chat_history:start session_id=%s task_id=%s before_message_id=%s limit=%s is_group_chat=%s statuses=%s",
        session_id,
        task_id,
        before_message_id,
        limit,
        is_group_chat,
        [status.value for status in history_statuses],
    )

    task = task_store.get_by_id(db, task_id=task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    items = task_fork_history_resolver.resolve_for_task(
        db,
        task_id=task_id,
        user_id=task.user_id,
        before_message_id=before_message_id,
    )
    subtasks = [
        item.subtask for item in items if item.subtask.status in history_statuses
    ]
    if limit is not None and limit > 0:
        subtasks = subtasks[-limit:]

    # Convert to message format with full context loading
    messages = [
        msg for st in subtasks for msg in subtask_to_messages(st, db, is_group_chat)
    ]

    logger.debug(
        "get_chat_history: session_id=%s, count=%d, is_group_chat=%s, limit=%s",
        session_id,
        len(messages),
        is_group_chat,
        limit,
    )
    logger.info(
        "get_chat_history:done session_id=%s task_id=%s count=%d message_ids=%s",
        session_id,
        task_id,
        len(messages),
        [st.message_id for st in subtasks],
    )

    return HistoryResponse(session_id=session_id, messages=messages)


class AttachmentTextResponse(BaseModel):
    """A character slice of an attachment's extracted text."""

    attachment_id: int
    name: str
    mime_type: str
    total_chars: int
    offset: int
    text: str
    has_more: bool
    # Whether extracted_text itself was parse-truncated. When True, paging to
    # has_more=False means "end of the extract", NOT "end of the original file".
    source_truncated: bool


@router.get("/attachments/{attachment_id}/text", response_model=AttachmentTextResponse)
async def get_attachment_text(
    attachment_id: int,
    session_id: str = Query(..., description="Conversation session, e.g. task-123"),
    offset: int = Query(0, ge=0, description="Start character offset (codepoint)"),
    limit: int = Query(
        ...,
        gt=0,
        le=MAX_ATTACHMENT_TEXT_SLICE,
        description="Max characters to return (codepoint)",
    ),
    db: Session = Depends(get_db),
):
    """Return a character slice of an attachment's extracted text.

    Scoped to the conversation: the attachment must belong to a subtask of the
    session's task, or be unlinked *and owned by the task's user*. This mirrors
    the visibility of attachments already injected into the chat history, so
    group-chat members can read each other's attachments while cross-task access
    is denied. Unlinked attachments (subtask_id == 0, e.g. a just-uploaded or
    quick-launch preset attachment not yet bound to a subtask) are restricted to
    the same user, so the model cannot probe arbitrary ids across users.
    Pagination/token budgeting is done by the caller (chat_shell); this endpoint
    only slices.
    """
    session_type, task_id = parse_session_id(session_id)
    if session_type != "task":
        raise HTTPException(
            status_code=400, detail="Only task-based sessions are supported"
        )

    task = task_store.get_by_id(db, task_id=task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

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
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Task scoping: a linked attachment must belong to this task; an unlinked
    # one (subtask_id == 0) must at least belong to this task's user, so the
    # model cannot read arbitrary unlinked attachments across users.
    task_subtask_ids = set(subtask_store.list_ids_by_task(db, task_id=task_id))
    is_in_task = context.subtask_id in task_subtask_ids
    is_unlinked_same_user = context.subtask_id == 0 and context.user_id == task.user_id
    if not (is_in_task or is_unlinked_same_user):
        raise HTTPException(
            status_code=403, detail="Attachment does not belong to this conversation"
        )

    full_text = context.extracted_text or ""
    total_chars = len(full_text)
    chunk = full_text[offset : offset + limit]
    return AttachmentTextResponse(
        attachment_id=attachment_id,
        name=context.name or "",
        mime_type=context.mime_type or "",
        total_chars=total_chars,
        offset=offset,
        text=chunk,
        has_more=offset + len(chunk) < total_chars,
        source_truncated=context.is_truncated,
    )


def _build_subtask_content_fields(
    role: SubtaskRole,
    message: MessageCreate | MessageUpdate,
) -> dict[str, Any]:
    """Build Subtask content fields from a chat message payload."""
    if role == SubtaskRole.USER:
        return {
            "prompt": (
                message.content
                if isinstance(message.content, str)
                else json.dumps(message.content, ensure_ascii=False)
            )
        }
    result: dict = {
        "value": (
            message.content
            if isinstance(message.content, str)
            else json.dumps(message.content, ensure_ascii=False)
        )
    }
    if getattr(message, "model_info", None):
        result["model_info"] = message.model_info
    return {"result": result}


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
    existing = subtask_store.get_first_by_task(db, task_id=task_id)
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
    next_message_id = subtask_store.get_next_message_id(db, task_id=task_id)

    # Create subtask
    content_fields = _build_subtask_content_fields(role, message)
    subtask = subtask_store.create_subtask(
        db,
        user_id=existing.user_id,
        task_id=task_id,
        team_id=existing.team_id,
        title="",
        bot_ids=existing.bot_ids,
        role=role,
        prompt=content_fields.get("prompt"),
        result=content_fields.get("result"),
        executor_namespace="",
        executor_name="",
        message_id=next_message_id,
        parent_id=None,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        error_message="",
    )
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
    existing = subtask_store.get_first_by_task(db, task_id=task_id)
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"No subtasks found for task {task_id}",
        )

    # Get next message_id
    next_message_id = subtask_store.get_next_message_id(db, task_id=task_id)

    message_ids = []
    for message in batch.messages:
        role = SubtaskRole.USER if message.role == "user" else SubtaskRole.ASSISTANT

        content_fields = _build_subtask_content_fields(role, message)
        subtask = subtask_store.create_subtask(
            db,
            user_id=existing.user_id,
            task_id=task_id,
            team_id=existing.team_id,
            title="",
            bot_ids=existing.bot_ids,
            role=role,
            prompt=content_fields.get("prompt"),
            result=content_fields.get("result"),
            executor_namespace="",
            executor_name="",
            message_id=next_message_id,
            parent_id=None,
            status=SubtaskStatus.COMPLETED,
            progress=100,
            error_message="",
        )
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

    subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
    if not subtask:
        raise HTTPException(status_code=404, detail="Message not found")

    subtask_store.update_fields(
        db,
        subtask=subtask,
        **_build_subtask_content_fields(subtask.role, update),
    )

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

    subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
    if not subtask:
        raise HTTPException(status_code=404, detail="Message not found")

    subtask_store.update_status(db, subtask=subtask, status=SubtaskStatus.DELETE)
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
    subtask_store.mark_task_messages_status(
        db,
        task_id=task_id,
        status=SubtaskStatus.DELETE,
    )
    db.commit()

    logger.debug("clear_history: session_id=%s", session_id)

    return SuccessResponse(success=True)


@router.get("/sessions", response_model=SessionListResponse)
async def list_sessions(
    limit: int = Query(
        100, ge=1, le=1000, description="Max number of sessions to return"
    ),
    offset: int = Query(0, ge=0, description="Offset for pagination"),
    db: Session = Depends(get_db),
):
    """
    List all session IDs (unique task IDs with subtasks).

    Note: This is primarily for CLI/testing. In production, sessions are
    typically managed by task_id which comes from the frontend.
    """
    task_ids = subtask_store.list_session_task_ids(db, skip=offset, limit=limit)
    sessions = [f"task-{task_id}" for task_id in task_ids]

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
