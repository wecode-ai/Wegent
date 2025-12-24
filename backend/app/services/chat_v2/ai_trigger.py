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
"""

import asyncio
import logging
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
        message: User message
        payload: Original chat send payload
        task_room: Task room name for WebSocket events
        supports_direct_chat: Whether team supports direct chat
        namespace: ChatNamespace instance for emitting events
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
) -> None:
    """
    Trigger direct chat (Chat Shell) AI response using ChatService.

    Emits chat:start event and starts streaming in background task.
    """
    from app.api.ws.events import ServerEvents

    # Extract data from ORM objects before starting background task
    # This prevents DetachedInstanceError
    task_data = {
        "id": task.id,
    }
    team_data = {
        "id": team.id,
        "user_id": team.user_id,
        "name": team.name,
        "json": team.json,
    }
    user_data = {
        "id": user.id,
        "user_name": user.user_name,
    }

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
            task_data=task_data,
            subtask_id=assistant_subtask.id,
            message_id=assistant_subtask.message_id,
            team_data=team_data,
            user_data=user_data,
            message=message,
            payload=payload,
            task_room=task_room,
            namespace=namespace,
            trace_context=trace_context,
            otel_context=otel_context,
        )
    )
    namespace._active_streams[assistant_subtask.id] = stream_task
    namespace._stream_versions[assistant_subtask.id] = "v2"
    logger.info("[ai_trigger] Background stream task started")


async def _stream_chat_response(
    task_data: dict[str, Any],
    subtask_id: int,
    message_id: int,
    team_data: dict[str, Any],
    user_data: dict[str, Any],
    message: str,
    payload: Any,
    task_room: str,
    namespace: Any,
    trace_context: Optional[Dict[str, Any]] = None,
    otel_context: Optional[Any] = None,
) -> None:
    """
    Stream chat response using ChatService.

    Uses ChatConfigBuilder to prepare configuration and delegates
    streaming to ChatService.stream_to_websocket().
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

    from app.api.ws.events import ServerEvents
    from app.services.chat_v2.config import ChatConfigBuilder
    from app.services.chat_v2.service import (
        WebSocketStreamConfig,
        chat_service,
    )

    db = SessionLocal()

    try:
        # Set base attributes (user and task info)
        span_manager.set_base_attributes(
            task_id=task_data["id"],
            subtask_id=subtask_id,
            user_id=str(user_data["id"]),
            user_name=user_data["user_name"],
        )

        # Get team Kind object from database
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_data["id"],
                Kind.kind == "Team",
                Kind.is_active,
            )
            .first()
        )

        if not team:
            error_msg = "Team not found"
            span_manager.record_error(TelemetryEventNames.TEAM_NOT_FOUND, error_msg)
            await namespace.emit(
                ServerEvents.CHAT_ERROR,
                {"subtask_id": subtask_id, "error": error_msg},
                room=task_room,
            )
            return

        # Use ChatConfigBuilder to prepare configuration
        config_builder = ChatConfigBuilder(
            db=db,
            team=team,
            user_id=user_data["id"],
            user_name=user_data["user_name"],
        )

        try:
            chat_config = config_builder.build(
                override_model_name=payload.force_override_bot_model,
                force_override=payload.force_override_bot_model is not None,
                enable_clarification=payload.enable_clarification,
                enable_deep_thinking=payload.enable_deep_thinking,
                task_id=task_data["id"],
            )
        except ValueError as e:
            error_msg = str(e)
            span_manager.record_error(
                TelemetryEventNames.CONFIG_BUILD_FAILED, error_msg
            )
            await namespace.emit(
                ServerEvents.CHAT_ERROR,
                {"subtask_id": subtask_id, "error": error_msg},
                room=task_room,
            )
            return

        # Add model info to span
        span_manager.set_model_attributes(chat_config.model_config)

        # Handle attachment
        final_message = message
        if payload.attachment_id:
            final_message = await _process_attachment(
                db, payload.attachment_id, user_data["id"], message
            )

        # Emit chat:start event with shell_type
        logger.info(
            "[ai_trigger] Emitting chat:start event with shell_type=%s",
            chat_config.shell_type,
        )
        await namespace.emit(
            ServerEvents.CHAT_START,
            {
                "task_id": task_data["id"],
                "subtask_id": subtask_id,
                "message_id": message_id,
                "shell_type": chat_config.shell_type,  # Include shell_type for frontend
            },
            room=task_room,
        )
        logger.info("[ai_trigger] chat:start emitted")

        # Create WebSocket stream config
        ws_config = WebSocketStreamConfig(
            task_id=task_data["id"],
            subtask_id=subtask_id,
            task_room=task_room,
            user_id=user_data["id"],
            user_name=user_data["user_name"],
            is_group_chat=payload.is_group_chat,
            enable_web_search=payload.enable_web_search,
            search_engine=payload.search_engine,
            message_id=message_id,
            bot_name=chat_config.bot_name,
            bot_namespace=chat_config.bot_namespace,
            shell_type=chat_config.shell_type,  # Pass shell_type from chat_config
        )

        # Use ChatService for streaming
        await chat_service.stream_to_websocket(
            message=final_message,
            model_config=chat_config.model_config,
            system_prompt=chat_config.system_prompt,
            config=ws_config,
            namespace=namespace,
        )

        # Mark span as successful
        span_manager.record_success(
            event_name=TelemetryEventNames.STREAM_COMPLETED,
        )

    except Exception as e:
        logger.exception("[ai_trigger] Stream error subtask=%d: %s", subtask_id, e)
        # Record error in span
        span_manager.record_exception(e)
        await namespace.emit(
            ServerEvents.CHAT_ERROR,
            {"subtask_id": subtask_id, "error": str(e)},
            room=task_room,
        )
    finally:
        # Detach OTEL context first (before exiting span)
        detach_otel_context(otel_token)

        # Exit span context
        span_manager.exit_span()

        db.close()


async def _process_attachment(
    db: Any,
    attachment_id: int,
    user_id: int,
    message: str,
) -> str:
    """
    Process attachment and build message with attachment content.

    Args:
        db: Database session
        attachment_id: Attachment ID
        user_id: User ID
        message: Original message

    Returns:
        Message with attachment content prepended if applicable
    """
    from app.models.subtask_attachment import AttachmentStatus
    from app.services.attachment import attachment_service

    attachment = attachment_service.get_attachment(
        db=db,
        attachment_id=attachment_id,
        user_id=user_id,
    )

    if attachment and attachment.status == AttachmentStatus.READY:
        return attachment_service.build_message_with_attachment(message, attachment)

    return message
