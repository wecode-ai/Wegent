# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Trigger Service.

This module handles triggering AI responses for chat messages.
It decouples the AI response logic from message saving, allowing for:
- Different AI backends (direct chat, executor, queue-based)
- Future extensibility (e.g., queue-based processing)
- Clean separation of concerns

Now uses ChatService with ChatConfigBuilder for direct chat streaming.
Uses ChatStreamContext for better parameter organization.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from shared.telemetry.context import (
    SpanManager,
    SpanNames,
    TelemetryEventNames,
    attach_otel_context,
    copy_context_vars,
    detach_otel_context,
    restore_context_vars,
)

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.user import User

logger = logging.getLogger(__name__)


@dataclass
class StreamTaskData:
    """Data extracted from ORM objects for background streaming task.

    This dataclass groups all the data needed for streaming that must be
    extracted from ORM objects before starting the background task.
    This prevents DetachedInstanceError when the session closes.
    """

    # Task data
    task_id: int

    # Team data
    team_id: int
    team_user_id: int
    team_name: str
    team_json: dict[str, Any]

    # User data
    user_id: int
    user_name: str

    # Subtask data (message ordering)
    subtask_id: int
    assistant_message_id: int
    user_message_id: int  # parent_id of assistant subtask

    @classmethod
    def from_orm(
        cls,
        task: Kind,
        team: Kind,
        user: User,
        assistant_subtask: Subtask,
    ) -> "StreamTaskData":
        """Extract data from ORM objects.

        Args:
            task: Task Kind object
            team: Team Kind object
            user: User object
            assistant_subtask: Assistant subtask (contains message_id and parent_id)

        Returns:
            StreamTaskData with all necessary fields extracted
        """
        return cls(
            task_id=task.id,
            team_id=team.id,
            team_user_id=team.user_id,
            team_name=team.name,
            team_json=team.json,
            user_id=user.id,
            user_name=user.user_name,
            subtask_id=assistant_subtask.id,
            assistant_message_id=assistant_subtask.message_id,
            user_message_id=assistant_subtask.parent_id,
        )


async def trigger_ai_response(
    task: Kind,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    message: str,
    payload: Any,
    task_room: str,
    supports_direct_chat: bool,
    namespace: Any,  # ChatNamespace instance for emitting events
    knowledge_base_ids: Optional[
        list[int]
    ] = None,  # Knowledge base IDs for tool-based RAG
) -> None:
    """
    Trigger AI response for a chat message.

    This function handles the AI response triggering logic, decoupled from
    message saving. It supports both direct chat (Chat Shell) and executor-based
    (ClaudeCode, Agno, etc.) AI responses.

    For direct chat:
    - Emits chat:start event
    - Starts streaming in background task

    For executor-based:
    - AI response is handled by executor_manager (no action needed here)

    Args:
        task: Task Kind object
        assistant_subtask: Assistant subtask for AI response
        team: Team Kind object
        user: User object
        message: User message (original query)
        payload: Original chat send payload
        task_room: Task room name for WebSocket events
        supports_direct_chat: Whether team supports direct chat
        namespace: ChatNamespace instance for emitting events
        knowledge_base_ids: Optional list of knowledge base IDs for tool-based RAG
    """
    logger.info(
        "[ai_trigger] Triggering AI response: task_id=%d, "
        "subtask_id=%d, supports_direct_chat=%s",
        task.id,
        assistant_subtask.id,
        supports_direct_chat,
    )

    if supports_direct_chat:
        # Direct chat (Chat Shell) - handle streaming locally
        await _trigger_direct_chat(
            task=task,
            assistant_subtask=assistant_subtask,
            team=team,
            user=user,
            message=message,
            payload=payload,
            task_room=task_room,
            namespace=namespace,
            knowledge_base_ids=knowledge_base_ids,
        )
    else:
        # Executor-based (ClaudeCode, Agno, etc.)
        # AI response is handled by executor_manager
        # The executor_manager polls for PENDING tasks and processes them
        logger.info(
            "[ai_trigger] Non-direct chat, AI response handled by executor_manager"
        )


async def _trigger_direct_chat(
    task: Kind,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    message: str,
    payload: Any,
    task_room: str,
    namespace: Any,
    knowledge_base_ids: Optional[list[int]] = None,
) -> None:
    """
    Trigger direct chat (Chat Shell) AI response using ChatService.

    Emits chat:start event and starts streaming in background task.

    Args:
        task: Task Kind object
        assistant_subtask: Assistant subtask (contains message_id and parent_id for ordering)
        team: Team Kind object
        user: User object
        message: User message text
        payload: Chat payload with feature flags
        task_room: WebSocket room name
        namespace: ChatNamespace instance
        knowledge_base_ids: Optional list of knowledge base IDs for tool-based RAG
    """
    # Extract data from ORM objects before starting background task
    # This prevents DetachedInstanceError when the session is closed
    stream_data = StreamTaskData.from_orm(task, team, user, assistant_subtask)

    # Copy ContextVars (request_id, user_id, etc.) AND trace context before starting background task
    # This ensures logging context and trace parent-child relationships are preserved in the background task
    trace_context = None
    otel_context = None
    try:
        if settings.OTEL_ENABLED:
            from opentelemetry import context

            trace_context = copy_context_vars()
            # Also copy OpenTelemetry context for parent-child span relationships
            otel_context = context.get_current()
    except Exception as e:
        logger.debug(f"Failed to copy trace context: {e}")

    # Start streaming in background task using ChatService
    logger.info("[ai_trigger] Starting background stream task with ChatService")
    stream_task = asyncio.create_task(
        _stream_chat_response(
            stream_data=stream_data,
            message=message,
            payload=payload,
            task_room=task_room,
            namespace=namespace,
            trace_context=trace_context,
            otel_context=otel_context,
            knowledge_base_ids=knowledge_base_ids,
        )
    )
    namespace._active_streams[assistant_subtask.id] = stream_task
    namespace._stream_versions[assistant_subtask.id] = "v2"
    logger.info("[ai_trigger] Background stream task started")


async def _stream_chat_response(
    stream_data: StreamTaskData,
    message: str,
    payload: Any,
    task_room: str,
    namespace: Any,
    trace_context: Optional[Dict[str, Any]] = None,
    otel_context: Optional[Any] = None,
    knowledge_base_ids: Optional[list[int]] = None,
) -> None:
    """
    Stream chat response using ChatService.

    Uses ChatConfigBuilder to prepare configuration and delegates
    streaming to ChatService.stream_to_websocket().

    Args:
        stream_data: StreamTaskData containing all extracted ORM data
        message: Original user message
        payload: Chat payload with feature flags (is_group_chat, enable_web_search, etc.)
        task_room: WebSocket room name
        namespace: ChatNamespace instance
        trace_context: Copied ContextVars for logging
        otel_context: OpenTelemetry context for tracing
        knowledge_base_ids: Optional list of knowledge base IDs for tool-based RAG
    """
    # Restore trace context at the start of background task
    # This ensures logging uses the correct request_id and user context
    if trace_context:
        try:
            restore_context_vars(trace_context)
            logger.debug(
                f"[ai_trigger] Restored trace context: request_id={trace_context.get('request_id')}"
            )
        except Exception as e:
            logger.debug(f"Failed to restore trace context: {e}")

    # Restore OpenTelemetry context to maintain parent-child span relationships
    otel_token = attach_otel_context(otel_context) if otel_context else None

    # Create OpenTelemetry span manager for this streaming operation
    span_manager = SpanManager(SpanNames.CHAT_STREAM_RESPONSE)
    span_manager.create_span()
    span_manager.enter_span()

    from app.services.chat_v2.config import ChatConfigBuilder
    from app.services.chat_v2.service import (
        WebSocketStreamConfig,
        chat_service,
    )

    db = SessionLocal()

    try:
        # Set base attributes (user and task info)
        span_manager.set_base_attributes(
            task_id=stream_data.task_id,
            subtask_id=stream_data.subtask_id,
            user_id=str(stream_data.user_id),
            user_name=stream_data.user_name,
        )

        # Get team Kind object from database
        team = (
            db.query(Kind)
            .filter(
                Kind.id == stream_data.team_id,
                Kind.kind == "Team",
                Kind.is_active,
            )
            .first()
        )

        if not team:
            error_msg = "Team not found"
            span_manager.record_error(TelemetryEventNames.TEAM_NOT_FOUND, error_msg)
            from app.services.chat.ws_emitter import get_ws_emitter

            error_emitter = get_ws_emitter()
            await error_emitter.emit_chat_error(
                task_id=stream_data.task_id,
                subtask_id=stream_data.subtask_id,
                error=error_msg,
            )
            return

        # Use ChatConfigBuilder to prepare configuration
        config_builder = ChatConfigBuilder(
            db=db,
            team=team,
            user_id=stream_data.user_id,
            user_name=stream_data.user_name,
        )

        try:
            chat_config = config_builder.build(
                override_model_name=payload.force_override_bot_model,
                force_override=payload.force_override_bot_model is not None,
                enable_clarification=payload.enable_clarification,
                enable_deep_thinking=payload.enable_deep_thinking,
                task_id=stream_data.task_id,
            )
        except ValueError as e:
            error_msg = str(e)
            span_manager.record_error(
                TelemetryEventNames.CONFIG_BUILD_FAILED, error_msg
            )
            from app.services.chat.ws_emitter import get_ws_emitter

            error_emitter = get_ws_emitter()
            await error_emitter.emit_chat_error(
                task_id=stream_data.task_id,
                subtask_id=stream_data.subtask_id,
                error=error_msg,
            )
            return

        # Add model info to span
        span_manager.set_model_attributes(chat_config.model_config)

        # Handle attachments (supports both single and multiple)
        # Convert single attachment_id to list for unified processing
        attachment_ids_to_process = []
        if payload.attachment_ids:
            attachment_ids_to_process = payload.attachment_ids
        elif payload.attachment_id:
            # Backward compatibility: convert single attachment_id to list
            attachment_ids_to_process = [payload.attachment_id]

        final_message = message
        if attachment_ids_to_process:
            final_message = await _process_attachments(
                db, attachment_ids_to_process, stream_data.user_id, message
            )

        # Emit chat:start event with shell_type using global emitter for cross-worker broadcasting
        logger.info(
            "[ai_trigger] Emitting chat:start event with shell_type=%s",
            chat_config.shell_type,
        )
        from app.services.chat.ws_emitter import get_ws_emitter

        start_emitter = get_ws_emitter()
        await start_emitter.emit_chat_start(
            task_id=stream_data.task_id,
            subtask_id=stream_data.subtask_id,
            message_id=stream_data.assistant_message_id,
            shell_type=chat_config.shell_type,
        )
        logger.info("[ai_trigger] chat:start emitted")

        # Prepare knowledge base tools and enhanced system prompt
        extra_tools, enhanced_system_prompt = _prepare_knowledge_base_tools(
            knowledge_base_ids=knowledge_base_ids,
            user_id=stream_data.user_id,
            db=db,
            base_system_prompt=chat_config.system_prompt,
        )

        # Create WebSocket stream config
        ws_config = WebSocketStreamConfig(
            task_id=stream_data.task_id,
            subtask_id=stream_data.subtask_id,
            task_room=task_room,
            user_id=stream_data.user_id,
            user_name=stream_data.user_name,
            is_group_chat=payload.is_group_chat,
            enable_web_search=payload.enable_web_search,
            search_engine=payload.search_engine,
            message_id=stream_data.assistant_message_id,
            user_message_id=stream_data.user_message_id,  # For history exclusion
            bot_name=chat_config.bot_name,
            bot_namespace=chat_config.bot_namespace,
            shell_type=chat_config.shell_type,  # Pass shell_type from chat_config
            extra_tools=extra_tools,  # Pass extra tools including KnowledgeBaseTool
        )

        # Use ChatService for streaming
        await chat_service.stream_to_websocket(
            message=final_message,
            model_config=chat_config.model_config,
            system_prompt=enhanced_system_prompt,  # Use enhanced system prompt
            config=ws_config,
            namespace=namespace,
        )

        # Mark span as successful
        span_manager.record_success(
            event_name=TelemetryEventNames.STREAM_COMPLETED,
        )

    except Exception as e:
        logger.exception(
            "[ai_trigger] Stream error subtask=%d: %s", stream_data.subtask_id, e
        )
        # Record error in span
        span_manager.record_exception(e)
        # Use global emitter for cross-worker broadcasting
        from app.services.chat.ws_emitter import get_ws_emitter

        error_emitter = get_ws_emitter()
        await error_emitter.emit_chat_error(
            task_id=stream_data.task_id,
            subtask_id=stream_data.subtask_id,
            error=str(e),
        )
    finally:
        # Detach OTEL context first (before exiting span)
        detach_otel_context(otel_token)

        # Exit span context
        span_manager.exit_span()

        db.close()


async def _process_attachments(
    db: Any,
    attachment_ids: list[int],
    user_id: int,
    message: str,
) -> str:
    """
    Process multiple attachments and build message with all attachment contents.

    Args:
        db: Database session (SQLAlchemy Session)
        attachment_ids: List of attachment IDs
        user_id: User ID
        message: Original message

    Returns:
        Message with all attachment contents prepended, or vision structure for images
    """
    from app.models.subtask_attachment import AttachmentStatus
    from app.services.attachment import attachment_service

    if not attachment_ids:
        return message

    # Collect all attachments
    text_attachments = []
    image_attachments = []

    for idx, attachment_id in enumerate(attachment_ids, start=1):
        attachment = attachment_service.get_attachment(
            db=db,
            attachment_id=attachment_id,
            user_id=user_id,
        )

        if attachment and attachment.status == AttachmentStatus.READY:
            # Separate images and text documents
            if (
                attachment_service.is_image_attachment(attachment)
                and attachment.image_base64
            ):
                image_attachments.append(
                    {
                        "image_base64": attachment.image_base64,
                        "mime_type": attachment.mime_type,
                        "filename": attachment.original_filename,
                    }
                )
            else:
                # For text documents, get the formatted content
                doc_prefix = attachment_service.build_document_text_prefix(attachment)
                if doc_prefix:
                    text_attachments.append(f"[Attachment {idx}]\n{doc_prefix}")

    # If we have images, return a multi-vision structure
    if image_attachments:
        # Build text content from text attachments
        combined_text = ""
        if text_attachments:
            combined_text = "\n".join(text_attachments) + "\n\n"
        combined_text += f"[User Question]:\n{message}"

        return {
            "type": "multi_vision",
            "text": combined_text,
            "images": image_attachments,
        }

    # If only text attachments, combine them
    if text_attachments:
        combined_attachments = "\n".join(text_attachments)
        return f"{combined_attachments}[User Question]:\n{message}"

    return message


def _prepare_knowledge_base_tools(
    knowledge_base_ids: Optional[list[int]],
    user_id: int,
    db: Any,
    base_system_prompt: str,
) -> tuple[list, str]:
    """
    Prepare knowledge base tools and enhanced system prompt.

    This function encapsulates the logic for creating KnowledgeBaseTool
    and enhancing the system prompt with knowledge base instructions.

    Args:
        knowledge_base_ids: Optional list of knowledge base IDs
        user_id: User ID for access control
        db: Database session
        base_system_prompt: Base system prompt to enhance

    Returns:
        Tuple of (extra_tools list, enhanced_system_prompt string)
    """
    extra_tools = []
    enhanced_system_prompt = base_system_prompt

    if not knowledge_base_ids:
        return extra_tools, enhanced_system_prompt

    logger.info(
        "[ai_trigger] Creating KnowledgeBaseTool for %d knowledge bases: %s",
        len(knowledge_base_ids),
        knowledge_base_ids,
    )

    # Import KnowledgeBaseTool
    from app.services.chat_v2.tools.builtin import KnowledgeBaseTool

    # Create KnowledgeBaseTool with the specified knowledge bases
    kb_tool = KnowledgeBaseTool(
        knowledge_base_ids=knowledge_base_ids,
        user_id=user_id,
        db_session=db,
    )
    extra_tools.append(kb_tool)

    # Enhance system prompt to REQUIRE AI to use the knowledge base tool
    # This is critical: we explicitly tell AI that knowledge bases have been selected
    # and it MUST use them to answer the question
    kb_instruction = """

# IMPORTANT: Knowledge Base Requirement

The user has selected specific knowledge bases for this conversation. You MUST use the `knowledge_base_search` tool to retrieve information from these knowledge bases before answering any questions.

## Required Workflow:
1. **ALWAYS** call `knowledge_base_search` first with the user's query
2. Wait for the search results
3. Base your answer **ONLY** on the retrieved information
4. If the search returns no results or irrelevant information, clearly state: "I cannot find relevant information in the selected knowledge base to answer this question."
5. **DO NOT** use your general knowledge or make assumptions beyond what's in the knowledge base

## Critical Rules:
- You MUST search the knowledge base for EVERY user question
- You MUST NOT answer without searching first
- You MUST NOT make up information if the knowledge base doesn't contain it
- If unsure, search again with different keywords

The user expects answers based on the selected knowledge base content only."""

    enhanced_system_prompt = f"{base_system_prompt}{kb_instruction}"

    logger.info(
        "[ai_trigger] ✅ Enhanced system prompt with REQUIRED knowledge base usage instructions:\n%s",
        kb_instruction.strip(),
    )

    return extra_tools, enhanced_system_prompt
