# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""AI Trigger Core - Main entry point for triggering AI responses.

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

    from app.chat_shell.agent import ChatAgent
    from app.services.chat.config import ChatConfigBuilder, WebSocketStreamConfig
    from app.services.chat.streaming import WebSocketStreamingHandler

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
                enable_deep_thinking=True,
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
            from app.services.chat.preprocessing import process_attachments

            final_message = await process_attachments(
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
        from app.chat_shell.tools.knowledge_factory import prepare_knowledge_base_tools

        extra_tools, enhanced_system_prompt = prepare_knowledge_base_tools(
            knowledge_base_ids=knowledge_base_ids,
            user_id=stream_data.user_id,
            db=db,
            base_system_prompt=chat_config.system_prompt,
        )

        # Prepare load_skill tool if skills are configured
        # Pass task_id to preload previously used skills for follow-up messages
        from app.chat_shell.tools.skill_factory import (
            prepare_load_skill_tool,
            prepare_skill_tools,
        )

        load_skill_tool = prepare_load_skill_tool(
            skill_names=chat_config.skill_names,
            user_id=stream_data.user_id,
            db=db,
            task_id=stream_data.task_id,
        )
        if load_skill_tool:
            extra_tools.append(load_skill_tool)

        # Prepare skill tools dynamically using SkillToolRegistry
        skill_tools = prepare_skill_tools(
            task_id=stream_data.task_id,
            subtask_id=stream_data.subtask_id,
            user_id=stream_data.user_id,
            db_session=db,
            skill_configs=chat_config.skill_configs,
        )
        extra_tools.extend(skill_tools)

        # Build skill metadata for prompt injection
        # Extract name and description from skill_configs for prompt enhancement
        skill_metadata = [
            {"name": s["name"], "description": s["description"]}
            for s in chat_config.skill_configs
            if "name" in s and "description" in s
        ]

        # Create WebSocket stream config
        ws_config = WebSocketStreamConfig(
            task_id=stream_data.task_id,
            subtask_id=stream_data.subtask_id,
            task_room=task_room,
            user_id=stream_data.user_id,
            user_name=stream_data.user_name,
            is_group_chat=payload.is_group_chat,
            enable_tools=True,  # Deep thinking enables tools
            enable_web_search=payload.enable_web_search,
            search_engine=payload.search_engine,
            message_id=stream_data.assistant_message_id,
            user_message_id=stream_data.user_message_id,  # For history exclusion
            bot_name=chat_config.bot_name,
            bot_namespace=chat_config.bot_namespace,
            shell_type=chat_config.shell_type,  # Pass shell_type from chat_config
            extra_tools=extra_tools,  # Pass extra tools including KnowledgeBaseTool
            # Prompt enhancement options
            enable_clarification=chat_config.enable_clarification,
            enable_deep_thinking=chat_config.enable_deep_thinking,
            skills=skill_metadata,  # Skill metadata for prompt injection
        )

        # Create ChatAgent and WebSocketStreamingHandler for streaming
        agent = ChatAgent()
        handler = WebSocketStreamingHandler(agent)
        await handler.stream_to_websocket(
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
