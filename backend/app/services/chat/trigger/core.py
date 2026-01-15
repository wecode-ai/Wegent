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
    SpanAttributes,
    SpanManager,
    SpanNames,
    TelemetryEventNames,
    attach_otel_context,
    copy_context_vars,
    detach_otel_context,
    restore_context_vars,
    set_span_attributes,
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
    user_subtask_id: Optional[
        int
    ] = None,  # User subtask ID for unified context processing
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
        user_subtask_id: Optional user subtask ID for unified context processing
            (attachments and knowledge bases are retrieved from this subtask's contexts)
    """
    logger.info(
        "[ai_trigger] Triggering AI response: task_id=%d, "
        "subtask_id=%d, supports_direct_chat=%s, user_subtask_id=%s",
        task.id,
        assistant_subtask.id,
        supports_direct_chat,
        user_subtask_id,
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
            user_subtask_id=user_subtask_id,
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
    user_subtask_id: Optional[int] = None,
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
        user_subtask_id: Optional user subtask ID for unified context processing
            (attachments and knowledge bases are retrieved from this subtask's contexts)
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
            user_subtask_id=user_subtask_id,
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
    user_subtask_id: Optional[int] = None,
) -> None:
    """
    Stream chat response using ChatService.

    Uses ChatConfigBuilder to prepare configuration and delegates
    streaming to ChatService.stream_to_websocket().

    Now uses unified context processing based on user_subtask_id,
    which retrieves both attachments and knowledge bases from the
    subtask's associated contexts.

    Args:
        stream_data: StreamTaskData containing all extracted ORM data
        message: Original user message
        payload: Chat payload with feature flags (is_group_chat, enable_web_search, etc.)
        task_room: WebSocket room name
        namespace: ChatNamespace instance
        trace_context: Copied ContextVars for logging
        otel_context: OpenTelemetry context for tracing
        user_subtask_id: Optional user subtask ID for unified context processing
            (attachments and knowledge bases are retrieved from this subtask's contexts)
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

    from chat_shell.agent import ChatAgent

    from app.services.chat.config import ChatConfigBuilder, WebSocketStreamConfig
    from app.services.chat.streaming import WebSocketBridge, WebSocketStreamingHandler

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
                preload_skills=getattr(payload, "preload_skills", None),
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

        # Unified context processing: process both attachments and knowledge bases
        # from the user subtask's associated contexts
        final_message = message
        enhanced_system_prompt = chat_config.system_prompt
        extra_tools = []

        logger.info(
            f"[ai_trigger] Context processing: user_subtask_id={user_subtask_id}, "
            f"task_id={stream_data.task_id}"
        )

        has_table_context = False
        table_contexts = []
        if user_subtask_id:
            from app.services.chat.preprocessing import prepare_contexts_for_chat

            (
                final_message,
                enhanced_system_prompt,
                extra_tools,
                has_table_context,
                table_contexts,
            ) = await prepare_contexts_for_chat(
                db=db,
                user_subtask_id=user_subtask_id,
                user_id=stream_data.user_id,
                message=message,
                base_system_prompt=chat_config.system_prompt,
                task_id=stream_data.task_id,
            )
            logger.info(
                f"[ai_trigger] Unified context processing completed: "
                f"user_subtask_id={user_subtask_id}, "
                f"extra_tools_count={len(extra_tools)}, "
                f"extra_tools={[t.name for t in extra_tools]}, "
                f"has_table_context={has_table_context}, "
                f"table_contexts_count={len(table_contexts)}, "
                f"table_contexts={table_contexts}"
            )
        else:
            logger.warning(
                f"[ai_trigger] user_subtask_id is None, skipping context processing"
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

        # Check streaming mode early to determine if we need to create tools here
        streaming_mode = settings.STREAMING_MODE.lower()
        chat_shell_mode = settings.CHAT_SHELL_MODE.lower()

        # Build skill metadata for prompt injection
        # Extract name and description from skill_configs for prompt enhancement
        skill_metadata = [
            {"name": s["name"], "description": s["description"]}
            for s in chat_config.skill_configs
            if "name" in s and "description" in s
        ]

        # Only create tools locally for bridge/legacy modes
        # In HTTP mode, chat_shell service creates its own tools
        if chat_shell_mode != "http":
            # Prepare load_skill tool if skills are configured
            # Pass task_id to preload previously used skills for follow-up messages
            from chat_shell.tools.skill_factory import (
                prepare_load_skill_tool,
                prepare_skill_tools,
            )

            load_skill_tool = prepare_load_skill_tool(
                skill_names=chat_config.skill_names,
                user_id=stream_data.user_id,
                skill_configs=chat_config.skill_configs,
            )
            if load_skill_tool:
                extra_tools.append(load_skill_tool)

            # Prepare skill tools dynamically using SkillToolRegistry
            skill_tools = await prepare_skill_tools(
                task_id=stream_data.task_id,
                subtask_id=stream_data.subtask_id,
                user_id=stream_data.user_id,
                skill_configs=chat_config.skill_configs,
                load_skill_tool=load_skill_tool,
                user_name=stream_data.user_name,
            )
            extra_tools.extend(skill_tools)

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
            has_table_context=has_table_context,  # Pass table context flag
        )

        if chat_shell_mode == "http":
            # HTTP mode: Call chat_shell service via HTTP/SSE
            # Get knowledge_base_ids and document_ids from user subtask's contexts
            knowledge_base_ids = None
            document_ids = None
            is_user_selected_kb = False

            if user_subtask_id:
                from app.services.chat.preprocessing.contexts import (
                    _get_bound_knowledge_base_ids,
                    get_document_ids_from_subtask,
                    get_knowledge_base_ids_from_subtask,
                )

                # Priority 1: Get subtask-level KB selection (user explicitly selected for this message)
                knowledge_base_ids = get_knowledge_base_ids_from_subtask(
                    db, user_subtask_id
                )
                is_user_selected_kb = bool(knowledge_base_ids)

                if knowledge_base_ids:
                    document_ids = get_document_ids_from_subtask(db, user_subtask_id)
                    logger.info(
                        "[ai_trigger] HTTP mode: subtask-level KB selected, knowledge_base_ids=%s, "
                        "document_ids=%s (strict mode)",
                        knowledge_base_ids,
                        document_ids,
                    )
                elif stream_data.task_id:
                    # Priority 2: Fall back to task-level bound knowledge bases
                    knowledge_base_ids = _get_bound_knowledge_base_ids(
                        db, stream_data.task_id
                    )
                    if knowledge_base_ids:
                        logger.info(
                            "[ai_trigger] HTTP mode: task-level KB fallback, knowledge_base_ids=%s (relaxed mode)",
                            knowledge_base_ids,
                        )

            await _stream_with_http_adapter(
                stream_data=stream_data,
                message=final_message,
                model_config=chat_config.model_config,
                system_prompt=enhanced_system_prompt,
                ws_config=ws_config,
                extra_tools=extra_tools,
                skill_names=chat_config.skill_names,
                skill_configs=chat_config.skill_configs,
                knowledge_base_ids=knowledge_base_ids,
                document_ids=document_ids,
                table_contexts=table_contexts,
                is_user_selected_kb=is_user_selected_kb,
                preload_skills=chat_config.preload_skills,  # Use resolved from ChatConfig
                user_subtask_id=user_subtask_id,  # Pass user subtask ID for RAG persistence
            )
        elif streaming_mode == "bridge":
            # New architecture: StreamingCore publishes to Redis, WebSocketBridge forwards
            await _stream_with_bridge(
                stream_data=stream_data,
                message=final_message,
                model_config=chat_config.model_config,
                system_prompt=enhanced_system_prompt,
                ws_config=ws_config,
                namespace=namespace,
            )
        else:
            # Legacy architecture: WebSocketStreamingHandler emits directly
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


async def _stream_with_http_adapter(
    stream_data: StreamTaskData,
    message: str,
    model_config: dict,
    system_prompt: str,
    ws_config: Any,
    extra_tools: list,
    skill_names: list = None,
    skill_configs: list = None,
    knowledge_base_ids: list = None,
    document_ids: list = None,
    table_contexts: list = None,
    is_user_selected_kb: bool = True,
    preload_skills: list = None,
    user_subtask_id: Optional[int] = None,
) -> None:
    """Stream using HTTP adapter to call remote chat_shell service.

    This function:
    1. Builds a ChatRequest from the parameters
    2. Uses HTTPAdapter to call chat_shell's /v1/response API
    3. Processes SSE events and forwards them to WebSocket
    4. Checks Redis cancel flag and disconnects from chat_shell when cancelled

    Args:
        stream_data: StreamTaskData containing all extracted ORM data
        message: User message
        model_config: Model configuration
        system_prompt: System prompt
        ws_config: WebSocket stream configuration
        extra_tools: Extra tools (note: tools are not sent via HTTP, handled by chat_shell)
        skill_names: List of available skill names for dynamic loading
        skill_configs: List of skill tool configurations
        knowledge_base_ids: List of knowledge base IDs to search
        document_ids: List of document IDs to filter retrieval
        table_contexts: List of table context dicts for DataTableTool
        is_user_selected_kb: Whether KB is explicitly selected by user (strict mode)
            or inherited from task (relaxed mode). Defaults to True for backward compatibility.
        preload_skills: List of skill names to preload into system prompt
        user_subtask_id: User subtask ID for RAG result persistence (different from
            stream_data.subtask_id which is AI response's subtask)
    """
    from app.core.config import settings
    from app.services.chat.adapters.http import HTTPAdapter
    from app.services.chat.adapters.interface import ChatEventType, ChatRequest
    from app.services.chat.storage import session_manager
    from app.services.chat.ws_emitter import get_ws_emitter

    task_id = ws_config.task_id
    subtask_id = ws_config.subtask_id

    # Register stream for cancellation support
    # This creates a local asyncio.Event and clears any existing Redis cancel flag
    cancel_event = await session_manager.register_stream(subtask_id)

    # Set task-level streaming status in Redis for fast lookup
    # This is checked by get_active_streaming() when client reconnects/refreshes
    # CRITICAL: Must be set BEFORE streaming starts so page refresh can detect active streaming
    logger.info(
        "[HTTP_ADAPTER] Setting task_streaming_status in Redis: task_id=%d, subtask_id=%d, "
        "user_id=%d, user_name=%s",
        task_id,
        subtask_id,
        stream_data.user_id,
        stream_data.user_name,
    )
    await session_manager.set_task_streaming_status(
        task_id=task_id,
        subtask_id=subtask_id,
        user_id=stream_data.user_id,
        username=stream_data.user_name,
    )

    logger.info(
        "[HTTP_ADAPTER] Starting HTTP streaming: task_id=%d, subtask_id=%d",
        task_id,
        subtask_id,
    )

    # Build task_data for MCP variable substitution
    # This must be built before _append_mcp_servers to support ${{user.name}} etc.
    task_data = {
        "user": {
            "name": str(stream_data.user_name or ""),
            "id": stream_data.user_id,
        },
        "task_id": task_id,
        "team_id": stream_data.team_id,
    }

    # Parse MCP servers with separate span (includes variable substitution)
    mcp_servers = _append_mcp_servers(
        ws_config.bot_name, ws_config.bot_namespace, task_data
    )

    # Append skills with separate span
    _append_skills(skill_names, skill_configs)

    # Append knowledge with separate span
    _append_knowledge(knowledge_base_ids, document_ids, table_contexts)

    # Build ChatRequest
    # Note: enable_web_search should follow settings.WEB_SEARCH_ENABLED for consistency with bridge mode
    # The ws_config.enable_web_search is for user override, but server-side setting takes precedence
    enable_web_search = ws_config.enable_web_search or getattr(
        settings, "WEB_SEARCH_ENABLED", False
    )

    chat_request = ChatRequest(
        task_id=task_id,
        subtask_id=subtask_id,
        user_subtask_id=user_subtask_id,  # User subtask ID for RAG persistence
        message=message,
        user_id=stream_data.user_id,
        user_name=stream_data.user_name,
        team_id=stream_data.team_id,
        team_name=stream_data.team_name,
        message_id=ws_config.message_id,
        user_message_id=ws_config.user_message_id,  # For history exclusion
        is_group_chat=ws_config.is_group_chat,
        model_config=model_config,
        system_prompt=system_prompt,
        enable_tools=ws_config.enable_tools,
        enable_web_search=enable_web_search,
        enable_clarification=ws_config.enable_clarification,
        enable_deep_thinking=ws_config.enable_deep_thinking,
        search_engine=ws_config.search_engine,
        bot_name=ws_config.bot_name,
        bot_namespace=ws_config.bot_namespace,
        skills=ws_config.skills or [],  # Skill metadata with preload field
        # Add skill and knowledge base parameters for HTTP mode
        skill_names=skill_names or [],
        skill_configs=skill_configs or [],
        preload_skills=preload_skills or [],  # Pass preload_skills to ChatRequest
        knowledge_base_ids=knowledge_base_ids,
        document_ids=document_ids,
        is_user_selected_kb=is_user_selected_kb,
        table_contexts=table_contexts or [],
        task_data=task_data,
        mcp_servers=mcp_servers,
    )

    logger.info(
        "[HTTP_ADAPTER] ChatRequest built: task_id=%d, subtask_id=%d, user_subtask_id=%s, "
        "skill_names=%s, table_contexts_count=%d, table_contexts=%s, "
        "skill_configs_count=%d, preload_skills=%s, knowledge_base_ids=%s, document_ids=%s",
        task_id,
        subtask_id,
        user_subtask_id,
        skill_names,
        len(table_contexts) if table_contexts else 0,
        table_contexts,  # Log the actual content
        len(skill_configs) if skill_configs else 0,
        preload_skills,
        knowledge_base_ids,
        document_ids,
    )

    # Record chat request details to trace
    # Note: MCP, Skills, Knowledge attributes are recorded in separate spans (append.mcp, append.skills, append.knowledge)
    set_span_attributes(
        {
            SpanAttributes.TASK_ID: task_id,
            SpanAttributes.SUBTASK_ID: subtask_id,
            SpanAttributes.CHAT_WEB_SEARCH: enable_web_search,
            SpanAttributes.CHAT_DEEP_THINKING: ws_config.enable_deep_thinking,
            SpanAttributes.CHAT_CLARIFICATION: ws_config.enable_clarification,
            SpanAttributes.CHAT_TYPE: "group" if ws_config.is_group_chat else "single",
        }
    )

    # Create HTTP adapter
    chat_shell_url = getattr(settings, "CHAT_SHELL_URL", "http://localhost:8100")
    chat_shell_token = getattr(settings, "CHAT_SHELL_TOKEN", "")

    adapter = HTTPAdapter(
        base_url=chat_shell_url,
        token=chat_shell_token,
        timeout=300.0,
    )

    # Get WebSocket emitter
    ws_emitter = get_ws_emitter()

    # Track full response and offset for WebSocket events
    full_response = ""
    offset = 0
    # Track thinking steps for tool events (to match frontend expectations)
    thinking_steps: list[dict] = []
    # Track if we were cancelled
    was_cancelled = False
    # Track last Redis save time for periodic saves (every 1 second)
    last_redis_save = asyncio.get_event_loop().time()
    redis_save_interval = 1.0  # Save to Redis every 1 second
    # Track TTFT (Time To First Token)
    stream_start_time = asyncio.get_event_loop().time()
    first_token_received = False

    try:
        # Stream events from chat_shell and forward to WebSocket
        async for event in adapter.chat(chat_request):
            # Check for cancellation (both local event and Redis flag)
            # This enables cross-worker cancellation: when user clicks cancel,
            # it may go to a different backend worker which sets Redis flag,
            # and this worker detects it here and disconnects from chat_shell
            if cancel_event.is_set() or await session_manager.is_cancelled(subtask_id):
                logger.info(
                    "[HTTP_ADAPTER] Cancellation detected, disconnecting from chat_shell: "
                    "task_id=%d, subtask_id=%d",
                    task_id,
                    subtask_id,
                )
                was_cancelled = True
                break

            if event.type == ChatEventType.CHUNK:
                # Text chunk - forward to WebSocket
                chunk_text = event.data.get("content", "")
                if chunk_text:
                    # Log TTFT (Time To First Token) for the first content chunk
                    if not first_token_received:
                        ttft_ms = (
                            asyncio.get_event_loop().time() - stream_start_time
                        ) * 1000
                        first_token_received = True
                        logger.info(
                            "[BACKEND_TTFT] First token received from chat_shell: "
                            "task_id=%d, subtask_id=%d, ttft_ms=%.2f, token_len=%d",
                            task_id,
                            subtask_id,
                            ttft_ms,
                            len(chunk_text),
                        )

                    full_response += chunk_text
                    await ws_emitter.emit_chat_chunk(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=chunk_text,
                        offset=offset,
                    )
                    offset += len(chunk_text)

                    # Periodic save to Redis for streaming recovery
                    # This allows page refresh to recover streaming content
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_redis_save >= redis_save_interval:
                        await session_manager.save_streaming_content(
                            subtask_id, full_response
                        )
                        last_redis_save = current_time

            elif event.type == ChatEventType.THINKING:
                # Thinking token - emit as chunk with special handling
                # The frontend distinguishes thinking by looking at result.thinking
                thinking_text = event.data.get("content", "")
                if thinking_text:
                    # Thinking content is sent as a separate chunk
                    # The chat_shell SSE should include thinking in result
                    pass  # Thinking is handled via result in DONE event

            elif event.type == ChatEventType.TOOL_START:
                # Tool start - add to thinking steps and emit chunk with result
                tool_id = event.data.get("id", "")
                tool_name = event.data.get("name", event.data.get("tool_name", ""))
                tool_input = event.data.get("input", event.data.get("tool_input", {}))
                display_name = event.data.get("display_name", tool_name)

                logger.info(
                    "[HTTP_ADAPTER] TOOL_START: id=%s, name=%s, display_name=%s, event.data=%s",
                    tool_id,
                    tool_name,
                    display_name,
                    event.data,
                )

                thinking_steps.append(
                    {
                        "title": display_name,
                        "next_action": "continue",
                        "run_id": tool_id,
                        "details": {
                            "type": "tool_use",
                            "tool_name": tool_name,
                            "name": tool_name,
                            "status": "started",
                            "input": tool_input,
                        },
                    }
                )

                # Emit chunk with thinking data
                result_data = {
                    "shell_type": "Chat",
                    "thinking": thinking_steps.copy(),
                }
                await ws_emitter.emit_chat_chunk(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content="",
                    offset=offset,
                    result=result_data,
                )

            elif event.type == ChatEventType.TOOL_RESULT:
                # Tool result - update thinking steps and emit chunk with result
                tool_id = event.data.get("id", "")
                tool_name = event.data.get("name", event.data.get("tool_name", ""))
                tool_output = event.data.get(
                    "output", event.data.get("tool_output", "")
                )

                logger.info(
                    "[HTTP_ADAPTER] TOOL_RESULT: id=%s, name=%s, event.data=%s",
                    tool_id,
                    tool_name,
                    {
                        k: v for k, v in event.data.items() if k != "output"
                    },  # Skip output to reduce log size
                )

                # Determine status based on event data
                # chat_shell sends error field directly in tool_done event when failed
                status = "completed"
                error_msg = event.data.get("error")
                if error_msg:
                    status = "failed"
                elif isinstance(tool_output, str) and tool_output:
                    # Also check tool_output JSON for success: false (fallback)
                    try:
                        import json

                        parsed = json.loads(tool_output)
                        if isinstance(parsed, dict) and parsed.get("success") is False:
                            status = "failed"
                            error_msg = parsed.get("error", "Task failed")
                    except (json.JSONDecodeError, TypeError):
                        pass

                # Use display_name from event data, or fall back to matching start step
                display_name = event.data.get("display_name", "")
                if not display_name:
                    for step in thinking_steps:
                        if (
                            step.get("run_id") == tool_id
                            and step.get("details", {}).get("status") == "started"
                        ):
                            orig_title = step.get("title", "")
                            if orig_title.startswith("正在"):
                                display_name = orig_title[2:]
                            else:
                                display_name = orig_title
                            break
                    if not display_name:
                        display_name = f"Tool completed: {tool_name}"

                tool_result_details = {
                    "type": "tool_result",
                    "tool_name": tool_name,
                    "status": status,
                    "output": tool_output,
                    "content": tool_output,
                }
                if status == "failed" and error_msg:
                    tool_result_details["error"] = error_msg

                thinking_steps.append(
                    {
                        "title": display_name,
                        "next_action": "continue",
                        "run_id": tool_id,
                        "details": tool_result_details,
                    }
                )

                # Emit chunk with thinking data
                result_data = {
                    "shell_type": "Chat",
                    "thinking": thinking_steps.copy(),
                }
                await ws_emitter.emit_chat_chunk(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content="",
                    offset=offset,
                    result=result_data,
                )

            elif event.type == ChatEventType.DONE:
                # Streaming done - emit done event
                result = event.data.get("result", {"value": full_response})

                # Ensure result has 'value' key
                if "value" not in result:
                    result["value"] = full_response

                # Include thinking steps if any
                if thinking_steps:
                    result["thinking"] = thinking_steps
                    result["shell_type"] = "Chat"

                # Preserve sources from result (knowledge base citations)
                # Sources are passed through from chat_shell's ResponseDone event
                if result.get("sources"):
                    logger.info(
                        "[HTTP_ADAPTER] Sources in result: %d items, sources=%s",
                        len(result["sources"]),
                        result["sources"],
                    )
                else:
                    logger.info("[HTTP_ADAPTER] No sources in result")

                # Update subtask status to COMPLETED in database
                # This is critical for persistence - without this, messages show as "running" after refresh
                from app.services.chat.storage.db import db_handler

                await db_handler.update_subtask_status(
                    subtask_id=subtask_id,
                    status="COMPLETED",
                    result=result,
                )

                await ws_emitter.emit_chat_done(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    offset=offset,
                    result=result,
                    message_id=ws_config.message_id,
                )
                # Also emit bot complete for multi-device sync
                await ws_emitter.emit_chat_bot_complete(
                    user_id=stream_data.user_id,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=full_response,
                    result=result,
                )

            elif event.type == ChatEventType.ERROR:
                # Error - emit error event
                error_msg = event.data.get("error", "Unknown error")
                logger.error(
                    "[HTTP_ADAPTER] Stream error: task_id=%d, error=%s",
                    task_id,
                    error_msg,
                )

                # Update subtask status to FAILED in database
                from app.services.chat.storage.db import db_handler

                await db_handler.update_subtask_status(
                    subtask_id=subtask_id,
                    status="FAILED",
                    error=error_msg,
                )

                await ws_emitter.emit_chat_error(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    error=error_msg,
                    message_id=ws_config.message_id,
                )

            elif event.type == ChatEventType.CANCELLED:
                # Cancelled - emit cancelled event

                # Update subtask status to CANCELLED in database
                from app.services.chat.storage.db import db_handler

                await db_handler.update_subtask_status(
                    subtask_id=subtask_id,
                    status="CANCELLED",
                )

                await ws_emitter.emit_chat_cancelled(
                    task_id=task_id,
                    subtask_id=subtask_id,
                )

        # Handle cancellation detected in the loop
        if was_cancelled:
            from app.services.chat.storage.db import db_handler

            # Build partial result
            result = {"value": full_response, "cancelled": True}
            if thinking_steps:
                result["thinking"] = thinking_steps
                result["shell_type"] = "Chat"

            # Update subtask status to COMPLETED with partial content
            await db_handler.update_subtask_status(
                subtask_id=subtask_id,
                status="COMPLETED",
                result=result,
            )

            # Emit cancelled event to WebSocket
            await ws_emitter.emit_chat_cancelled(
                task_id=task_id,
                subtask_id=subtask_id,
            )

            logger.info(
                "[HTTP_ADAPTER] Cancelled and cleaned up: task_id=%d, subtask_id=%d, "
                "partial_response_len=%d",
                task_id,
                subtask_id,
                len(full_response),
            )

    except Exception as e:
        logger.exception(
            "[HTTP_ADAPTER] Error during HTTP streaming: task_id=%d, error=%s",
            task_id,
            e,
        )

        # Update subtask status to FAILED in database
        from app.services.chat.storage.db import db_handler

        await db_handler.update_subtask_status(
            subtask_id=subtask_id,
            status="FAILED",
            error=str(e),
        )

        await ws_emitter.emit_chat_error(
            task_id=task_id,
            subtask_id=subtask_id,
            error=str(e),
        )

    finally:
        # Unregister stream to clean up local event and Redis cancel flag
        await session_manager.unregister_stream(subtask_id)
        # Clear task-level streaming status from Redis
        # This ensures get_active_streaming() returns None after streaming ends
        await session_manager.clear_task_streaming_status(task_id)
        # Clean up streaming content cache from Redis
        # This prevents stale data from being returned for future streams
        await session_manager.delete_streaming_content(subtask_id)


async def _stream_with_bridge(
    stream_data: StreamTaskData,
    message: str,
    model_config: dict,
    system_prompt: str,
    ws_config: Any,
    namespace: Any,
) -> None:
    """Stream using the new bridge architecture.

    This function:
    1. Starts WebSocketBridge to subscribe to Redis channel
    2. Uses chat_shell's StreamingCore with publish_to_channel=True
    3. StreamingCore publishes events to Redis
    4. WebSocketBridge forwards events to WebSocket

    Args:
        stream_data: StreamTaskData containing all extracted ORM data
        message: User message
        model_config: Model configuration
        system_prompt: System prompt
        ws_config: WebSocket stream configuration
        namespace: ChatNamespace instance
    """
    from chat_shell.agent import AgentConfig, ChatAgent
    from chat_shell.history import get_chat_history
    from chat_shell.services.streaming import (
        StreamingConfig,
        StreamingCore,
        StreamingState,
    )
    from chat_shell.services.streaming.emitters import RedisPublishingEmitter
    from chat_shell.tools import WebSearchTool
    from chat_shell.tools.events import create_tool_event_handler
    from chat_shell.tools.mcp import load_mcp_tools
    from langchain_core.tools.base import BaseTool

    from app.core.shutdown import shutdown_manager
    from app.services.chat.streaming import WebSocketBridge
    from app.services.chat.ws_emitter import get_ws_emitter

    subtask_id = ws_config.subtask_id
    task_id = ws_config.task_id
    task_room = ws_config.task_room

    # Create WebSocket bridge for Redis -> WebSocket forwarding
    bridge = WebSocketBridge(namespace, task_room, task_id)

    # Create Redis publishing emitter for bridge mode
    # This publishes events to Redis Pub/Sub channel, which WebSocketBridge forwards to WebSocket
    from app.services.chat.storage import session_manager

    emitter = RedisPublishingEmitter(storage_handler=session_manager)

    # Create streaming state
    state = StreamingState(
        task_id=task_id,
        subtask_id=subtask_id,
        user_id=ws_config.user_id,
        user_name=ws_config.user_name,
        is_group_chat=ws_config.is_group_chat,
        message_id=ws_config.message_id,
        shell_type=ws_config.shell_type,
    )

    # Create streaming config
    config = StreamingConfig()

    # Create streaming core
    core = StreamingCore(emitter, state, config)

    try:
        # Register with shutdown manager
        await shutdown_manager.register_stream(subtask_id)

        # Start the bridge to listen for Redis events
        if not await bridge.start(subtask_id):
            logger.error(
                "[BRIDGE] Failed to start WebSocket bridge: task_id=%d, subtask_id=%d",
                task_id,
                subtask_id,
            )
            return

        # Acquire resources (semaphore, cancel event)
        if not await core.acquire_resources():
            await bridge.stop()
            return

        # Prepare extra tools
        extra_tools: list[BaseTool] = (
            list(ws_config.extra_tools) if ws_config.extra_tools else []
        )

        logger.info(
            "[BRIDGE] Tool configuration: enable_tools=%s, CHAT_MCP_ENABLED=%s",
            ws_config.enable_tools,
            settings.CHAT_MCP_ENABLED,
        )

        if ws_config.enable_tools:
            # Load MCP tools if enabled
            if settings.CHAT_MCP_ENABLED:
                logger.info("[BRIDGE] Loading MCP tools for task %d", task_id)
                mcp_task_data = {
                    "user": {
                        "name": str(ws_config.user_name or ""),
                        "id": ws_config.user_id,
                    },
                }
                # Note: Table context is now handled via DataTableTool,
                # no need to pass table_mcp_config here
                mcp_client = await load_mcp_tools(
                    task_id,
                    ws_config.bot_name,
                    ws_config.bot_namespace,
                    task_data=mcp_task_data,
                )
                logger.info(
                    "[BRIDGE] MCP client created: %s, tools count: %d",
                    mcp_client is not None,
                    len(mcp_client.get_tools()) if mcp_client else 0,
                )
                if mcp_client:
                    extra_tools.extend(mcp_client.get_tools())
                    core.set_mcp_client(mcp_client)

            # Add web search tool if enabled
            if settings.WEB_SEARCH_ENABLED:
                search_engine = (
                    ws_config.search_engine if ws_config.search_engine else None
                )
                extra_tools.append(
                    WebSearchTool(
                        engine_name=search_engine,
                        default_max_results=settings.WEB_SEARCH_DEFAULT_MAX_RESULTS,
                    )
                )

        # Get chat history
        history = await get_chat_history(
            task_id,
            ws_config.is_group_chat,
            exclude_after_message_id=ws_config.user_message_id,
        )

        # Find LoadSkillTool for dynamic skill prompt injection
        load_skill_tool = None
        for tool in extra_tools:
            if tool.name == "load_skill":
                load_skill_tool = tool
                break

        # Create agent config
        agent = ChatAgent()
        agent_config = AgentConfig(
            model_config=model_config,
            system_prompt=system_prompt,
            max_iterations=settings.CHAT_TOOL_MAX_REQUESTS,
            extra_tools=extra_tools,
            load_skill_tool=load_skill_tool,
            enable_clarification=ws_config.enable_clarification,
            enable_deep_thinking=ws_config.enable_deep_thinking,
            skills=ws_config.skills,
        )

        # Build messages
        username = ws_config.get_username_for_message()
        model_id = model_config.get("model_id", "")
        messages = agent.build_messages(
            history,
            message,
            system_prompt,
            username=username,
            config=agent_config,
            model_id=model_id,
        )

        # Create agent builder for tool event handler
        agent_builder = agent.create_agent_builder(agent_config)

        logger.info(
            "[BRIDGE] Starting token streaming: task_id=%d, subtask_id=%d, tools=%d",
            task_id,
            subtask_id,
            len(extra_tools),
        )

        # Create tool event handler
        handle_tool_event = create_tool_event_handler(state, emitter, agent_builder)

        # Stream tokens
        token_count = 0
        async for token in agent.stream(
            messages,
            agent_config,
            cancel_event=core.cancel_event,
            on_tool_event=handle_tool_event,
        ):
            token_count += 1
            if not await core.process_token(token):
                logger.info(
                    "[BRIDGE] Streaming cancelled: task_id=%d, tokens=%d",
                    task_id,
                    token_count,
                )
                return

        logger.info(
            "[BRIDGE] Token streaming completed: task_id=%d, tokens=%d, response_len=%d",
            task_id,
            token_count,
            len(state.full_response),
        )

        # Finalize
        result = await core.finalize()

        # Update subtask status to COMPLETED in database
        # This is critical for persistence - without this, messages show as "running" after refresh
        from app.services.chat.storage.db import db_handler

        await db_handler.update_subtask_status(
            subtask_id=subtask_id,
            status="COMPLETED",
            result=result,
        )

        # Notify user room for multi-device sync
        ws_emitter = get_ws_emitter()
        if ws_emitter:
            await ws_emitter.emit_chat_bot_complete(
                user_id=ws_config.user_id,
                task_id=task_id,
                subtask_id=subtask_id,
                content=state.full_response,
                result=result,
            )

    except Exception as e:
        logger.exception("[BRIDGE] subtask=%s error", subtask_id)
        await core.handle_error(e)

        # Update subtask status to FAILED in database
        from app.services.chat.storage.db import db_handler

        await db_handler.update_subtask_status(
            subtask_id=subtask_id,
            status="FAILED",
            error=str(e),
        )

    finally:
        # Stop the bridge
        await bridge.stop()
        # Release resources
        await core.release_resources()
        await shutdown_manager.unregister_stream(subtask_id)

        if subtask_id in getattr(namespace, "_active_streams", {}):
            del namespace._active_streams[subtask_id]
        if subtask_id in getattr(namespace, "_stream_versions", {}):
            del namespace._stream_versions[subtask_id]


from shared.telemetry.decorators import trace_sync


@trace_sync(
    span_name="append.mcp",
    tracer_name="backend.chat",
)
def _append_mcp_servers(
    bot_name: Optional[str] = None,
    bot_namespace: Optional[str] = None,
    task_data: Optional[Dict[str, Any]] = None,
) -> list[Dict[str, Any]]:
    """Append MCP server configuration for HTTP mode.

    Creates a separate span for MCP server parsing and loading.
    Supports ${{path}} variable substitution in MCP server configs.

    Args:
        bot_name: Optional bot name to load Bot MCP servers
        bot_namespace: Optional bot namespace
        task_data: Optional task data for variable substitution (e.g., user.name, user.id)

    Returns:
        List of MCP server configurations with variables replaced
    """
    import json

    from shared.telemetry.context import SpanAttributes, set_span_attributes

    mcp_servers = []

    # Parse global MCP servers from settings
    if settings.CHAT_MCP_ENABLED:
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "{}")
        if mcp_servers_config:
            try:
                config = json.loads(mcp_servers_config)
                servers = config.get("mcpServers", {})
                for name, server_config in servers.items():
                    server_type = server_config.get("type", "streamable-http")
                    url = server_config.get("url", "")
                    headers = server_config.get("headers", {})
                    if url:
                        server_entry = {
                            "name": name,
                            "type": server_type,
                            "url": url,
                        }
                        if headers:
                            server_entry["auth"] = headers
                        mcp_servers.append(server_entry)
                logger.info(
                    "[MCP] Parsed global MCP servers: %d servers",
                    len(mcp_servers),
                )
                set_span_attributes(
                    {
                        SpanAttributes.MCP_SERVERS_COUNT: len(mcp_servers),
                        SpanAttributes.MCP_SERVER_NAMES: ",".join(
                            s["name"] for s in mcp_servers
                        ),
                    }
                )
            except json.JSONDecodeError as e:
                logger.warning("[MCP] Failed to parse CHAT_MCP_SERVERS: %s", e)

    # Load Bot MCP servers from Ghost configuration
    if bot_name:
        try:
            bot_mcp_servers = _get_bot_mcp_servers_for_http(
                bot_name, bot_namespace or "default"
            )
            bot_server_count = 0
            for name, server_config in bot_mcp_servers.items():
                server_type = server_config.get("type", "streamable-http")
                url = server_config.get("url", "")
                headers = server_config.get("headers", {})
                if url:
                    server_entry = {
                        "name": name,
                        "type": server_type,
                        "url": url,
                    }
                    if headers:
                        server_entry["auth"] = headers
                    mcp_servers.append(server_entry)
                    bot_server_count += 1
            if bot_server_count > 0:
                logger.info(
                    "[MCP] Added %d Bot MCP servers for bot %s/%s",
                    bot_server_count,
                    bot_namespace or "default",
                    bot_name,
                )
                set_span_attributes(
                    {
                        SpanAttributes.MCP_BOT_SERVERS_COUNT: bot_server_count,
                        SpanAttributes.BOT_NAME: f"{bot_namespace or 'default'}/{bot_name}",
                    }
                )
        except Exception as e:
            logger.warning("[MCP] Failed to load Bot MCP servers: %s", e)

    # Apply variable substitution to all MCP servers
    # This replaces ${{user.name}}, ${{user.id}}, etc. with actual values from task_data
    if mcp_servers and task_data:
        from shared.utils.mcp_utils import replace_mcp_server_variables

        mcp_servers = replace_mcp_server_variables(mcp_servers, task_data)
        logger.info(
            "[MCP] Applied variable substitution to %d MCP servers",
            len(mcp_servers),
        )

    return mcp_servers


@trace_sync(
    span_name="append.skills",
    tracer_name="backend.chat",
)
def _append_skills(
    skill_names: Optional[list[str]] = None,
    skill_configs: Optional[list[dict]] = None,
) -> tuple[list[str], list[dict]]:
    """Append skills configuration.

    Args:
        skill_names: List of skill names
        skill_configs: List of skill configurations

    Returns:
        Tuple of (skill_names, skill_configs)
    """
    from shared.telemetry.context import SpanAttributes, set_span_attributes

    names = skill_names or []
    configs = skill_configs or []

    if names or configs:
        logger.info(
            "[SKILLS] Appending skills: names=%s, configs_count=%d", names, len(configs)
        )
        set_span_attributes(
            {
                SpanAttributes.SKILL_NAMES: ",".join(names) if names else "",
                SpanAttributes.SKILL_COUNT: len(configs),
            }
        )

    return names, configs


@trace_sync(
    span_name="append.knowledge",
    tracer_name="backend.chat",
)
def _append_knowledge(
    knowledge_base_ids: Optional[list[int]] = None,
    document_ids: Optional[list[int]] = None,
    table_contexts: Optional[list[dict]] = None,
) -> tuple[Optional[list[int]], Optional[list[int]], list[dict]]:
    """Append knowledge base configuration.

    Args:
        knowledge_base_ids: List of knowledge base IDs
        document_ids: List of document IDs
        table_contexts: List of table contexts

    Returns:
        Tuple of (knowledge_base_ids, document_ids, table_contexts)
    """
    from shared.telemetry.context import SpanAttributes, set_span_attributes

    contexts = table_contexts or []

    if knowledge_base_ids or document_ids or contexts:
        logger.info(
            "[KNOWLEDGE] Appending knowledge: kb_ids=%s, doc_ids=%s, table_contexts_count=%d",
            knowledge_base_ids,
            document_ids,
            len(contexts),
        )
        set_span_attributes(
            {
                SpanAttributes.KB_IDS: (
                    ",".join(map(str, knowledge_base_ids)) if knowledge_base_ids else ""
                ),
                SpanAttributes.KB_DOCUMENT_IDS: (
                    ",".join(map(str, document_ids)) if document_ids else ""
                ),
                SpanAttributes.KB_TABLE_CONTEXTS_COUNT: len(contexts),
            }
        )

    return knowledge_base_ids, document_ids, contexts


def _get_bot_mcp_servers_for_http(bot_name: str, bot_namespace: str) -> Dict[str, Any]:
    """Get Bot MCP servers configuration from Ghost CRD for HTTP mode.

    Args:
        bot_name: Bot name to query Ghost MCP configuration
        bot_namespace: Bot namespace for Ghost query

    Returns:
        Dict of MCP server configurations: {server_name: {url, type, headers, ...}}
    """
    from app.db.session import SessionLocal
    from app.models.kind import Kind
    from app.schemas.kind import Bot, Ghost

    db = SessionLocal()
    try:
        # Query bot Kind
        bot_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == bot_namespace,
                Kind.is_active,
            )
            .first()
        )

        if not bot_kind or not bot_kind.json:
            return {}

        # Parse Bot CRD to get ghostRef
        bot_crd = Bot.model_validate(bot_kind.json)
        if not bot_crd.spec or not bot_crd.spec.ghostRef:
            return {}

        ghost_name = bot_crd.spec.ghostRef.name
        ghost_namespace = bot_crd.spec.ghostRef.namespace

        # Query Ghost Kind
        ghost_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Ghost",
                Kind.name == ghost_name,
                Kind.namespace == ghost_namespace,
                Kind.is_active,
            )
            .first()
        )

        if not ghost_kind or not ghost_kind.json:
            return {}

        # Parse Ghost CRD to get mcpServers
        ghost_crd = Ghost.model_validate(ghost_kind.json)
        if not ghost_crd.spec or not ghost_crd.spec.mcpServers:
            return {}

        return ghost_crd.spec.mcpServers

    except Exception:
        logger.exception(
            "[HTTP_ADAPTER] Failed to query bot MCP servers for %s/%s",
            bot_namespace,
            bot_name,
        )
        return {}
    finally:
        db.close()
