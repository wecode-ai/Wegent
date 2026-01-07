# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""WebSocket Streaming Handler for Chat Service.

This module provides the WebSocket streaming handler that:
- Handles WebSocket event emission (chat:chunk, chat:done, chat:error, chat:cancelled)
- Manages MCP tool loading and cleanup
- Integrates with shutdown manager
"""

import logging
from typing import Any

from chat_shell.agent import AgentConfig, ChatAgent
from chat_shell.history import get_chat_history
from chat_shell.tools.events import create_tool_event_handler
from chat_shell.tools.mcp import load_mcp_tools
from langchain_core.tools.base import BaseTool

from app.core.config import settings
from app.services.streaming import (
    StreamingConfig,
    StreamingCore,
    StreamingState,
    WebSocketEmitter,
)

from ..config import WebSocketStreamConfig

logger = logging.getLogger(__name__)


class WebSocketStreamingHandler:
    """Handler for chat streaming over WebSocket.

    This class bridges the ChatAgent with WebSocket streaming infrastructure:
    - Uses ChatAgent for agent execution
    - Uses streaming module for protocol handling
    - Handles tool event callbacks and thinking steps
    - Manages MCP tools and shutdown integration
    """

    def __init__(self, agent: ChatAgent):
        """Initialize WebSocket streaming handler.

        Args:
            agent: ChatAgent instance for agent operations
        """
        self.agent = agent

    async def stream_to_websocket(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        config: WebSocketStreamConfig,
        namespace: Any,
        max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS,
    ) -> None:
        """Stream chat response via WebSocket using StreamingCore.

        This method handles:
        - MCP tool loading and cleanup
        - Dynamic web search tool
        - Shutdown manager integration
        - WebSocket event emission (chat:chunk, chat:done, chat:error, chat:cancelled)

        Args:
            message: User message (string or dict)
            model_config: Model configuration from ModelResolver
            system_prompt: System prompt
            config: WebSocket streaming configuration
            namespace: ChatNamespace instance for emitting events
            max_iterations: Max tool loop iterations
        """
        from chat_shell.tools import WebSearchTool
        from opentelemetry import trace
        from shared.telemetry.context import (
            SpanNames,
            set_task_context,
        )
        from shared.telemetry.core import is_telemetry_enabled

        from app.core.shutdown import shutdown_manager
        from app.services.chat.ws_emitter import get_ws_emitter

        subtask_id = config.subtask_id
        task_id = config.task_id
        task_room = config.task_room

        # Set task context for tracing (propagates to all child spans)
        set_task_context(task_id=task_id, subtask_id=subtask_id)

        # Create WebSocket emitter
        emitter = WebSocketEmitter(namespace, task_room, task_id)

        # Create streaming state
        state = StreamingState(
            task_id=task_id,
            subtask_id=subtask_id,
            user_id=config.user_id,
            user_name=config.user_name,
            is_group_chat=config.is_group_chat,
            message_id=config.message_id,
            shell_type=config.shell_type,
        )

        # Create streaming core
        core = StreamingCore(emitter, state, StreamingConfig())

        try:
            # Register with shutdown manager (always succeeds for existing connections)
            # New WebSocket connections are rejected at on_connect level during shutdown
            await shutdown_manager.register_stream(subtask_id)

            # Acquire resources
            if not await core.acquire_resources():
                return

            # Prepare extra tools (only if tools are enabled)
            extra_tools: list[BaseTool] = []

            if config.enable_tools:
                # Add extra tools from config (e.g., KnowledgeBaseTool, skill tools)
                extra_tools.extend(config.extra_tools)

                # Load MCP tools if enabled
                if settings.CHAT_MCP_ENABLED:
                    # Build task_data for MCP variable substitution
                    mcp_task_data = {
                        "user": {
                            "name": str(config.user_name or ""),
                            "id": config.user_id,
                        }
                    }
                    mcp_client = await load_mcp_tools(
                        task_id,
                        config.bot_name,
                        config.bot_namespace,
                        task_data=mcp_task_data,
                    )
                    if mcp_client:
                        extra_tools.extend(mcp_client.get_tools())
                        core.set_mcp_client(mcp_client)

                # Always add web search tool if web search is enabled in settings
                if settings.WEB_SEARCH_ENABLED:
                    # Use specified search engine or default to first one
                    search_engine = (
                        config.search_engine if config.search_engine else None
                    )
                    extra_tools.append(
                        WebSearchTool(
                            engine_name=search_engine,
                            default_max_results=settings.WEB_SEARCH_DEFAULT_MAX_RESULTS,
                        )
                    )
            else:
                logger.info(
                    "[WS_STREAM] Tools disabled for this session: task_id=%d, subtask_id=%d",
                    task_id,
                    subtask_id,
                )

            # Get chat history (exclude current user message to avoid duplication)
            history = await get_chat_history(
                task_id,
                config.is_group_chat,
                exclude_after_message_id=config.user_message_id,
            )

            # Find LoadSkillTool from extra_tools for dynamic skill prompt injection
            load_skill_tool = None
            for tool in extra_tools:
                if tool.name == "load_skill":
                    load_skill_tool = tool
                    logger.info(
                        "[WS_STREAM] Found LoadSkillTool for dynamic skill prompt injection"
                    )
                    break

            # Create agent config with prompt enhancement options
            agent_config = AgentConfig(
                model_config=model_config,
                system_prompt=system_prompt,
                max_iterations=max_iterations,
                extra_tools=extra_tools,
                load_skill_tool=load_skill_tool,
                enable_clarification=config.enable_clarification,
                enable_deep_thinking=config.enable_deep_thinking,
                skills=config.skills,
            )

            # Build messages (prompt enhancements applied internally based on config)
            # Pass model_id for automatic compression when context limit is exceeded
            username = config.get_username_for_message()
            model_id = model_config.get("model_id", "")
            messages = self.agent.build_messages(
                history,
                message,
                system_prompt,
                username=username,
                config=agent_config,
                model_id=model_id,
            )

            # Log messages sent to model for debugging
            self._log_messages_for_debug(task_id, subtask_id, messages)

            # Create agent builder for tool event handler
            agent_builder = self.agent.create_agent_builder(agent_config)

            logger.info(
                "[WS_STREAM] Starting token streaming: task_id=%d, subtask_id=%d, tools=%d",
                task_id,
                subtask_id,
                len(extra_tools),
            )

            # Create tool event handler
            handle_tool_event = create_tool_event_handler(state, emitter, agent_builder)

            # Stream tokens
            token_count = 0
            async for token in self.agent.stream(
                messages,
                agent_config,
                cancel_event=core.cancel_event,
                on_tool_event=handle_tool_event,
            ):
                token_count += 1
                if not await core.process_token(token):
                    # Cancelled or shutdown
                    logger.info(
                        "[WS_STREAM] Streaming cancelled: task_id=%d, tokens=%d",
                        task_id,
                        token_count,
                    )
                    return

            logger.info(
                "[WS_STREAM] Token streaming completed: task_id=%d, tokens=%d, response_len=%d",
                task_id,
                token_count,
                len(state.full_response),
            )

            # Finalize
            result = await core.finalize()

            # Notify user room for multi-device sync
            ws_emitter = get_ws_emitter()
            if ws_emitter:
                await ws_emitter.emit_chat_bot_complete(
                    user_id=config.user_id,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=state.full_response,
                    result=result,
                )

        except Exception as e:
            from shared.telemetry.context import (
                TelemetryEventNames,
                record_stream_error,
                set_task_context,
            )

            logger.exception("[WS_STREAM] subtask=%s error", subtask_id)

            # Ensure task context is set for trace
            set_task_context(task_id=task_id, subtask_id=subtask_id)

            # Record error in OpenTelemetry trace using unified function
            record_stream_error(
                error=e,
                event_name=TelemetryEventNames.STREAM_ERROR,
                task_id=task_id,
                subtask_id=subtask_id,
                extra_attributes={
                    "shell_type": config.shell_type,
                    "tools_count": len(extra_tools) if "extra_tools" in dir() else 0,
                    "token_count": token_count if "token_count" in dir() else 0,
                },
            )

            await core.handle_error(e)

        finally:
            # Cleanup
            await core.release_resources()
            await shutdown_manager.unregister_stream(subtask_id)

            if subtask_id in getattr(namespace, "_active_streams", {}):
                del namespace._active_streams[subtask_id]
            if subtask_id in getattr(namespace, "_stream_versions", {}):
                del namespace._stream_versions[subtask_id]

    def _log_messages_for_debug(
        self, task_id: int, subtask_id: int, messages: list[dict[str, Any]]
    ) -> None:
        """Log messages sent to model for debugging purposes."""
        if not messages:
            logger.info(
                "[MODEL_INPUT] task_id=%d, subtask_id=%d, messages=[]",
                task_id,
                subtask_id,
            )
            return

        role_counts = {}
        for msg in messages:
            role = msg.get("role", "unknown")
            role_counts[role] = role_counts.get(role, 0) + 1

        msg_summaries = []
        for i, msg in enumerate(messages):
            role = msg.get("role", "unknown")
            content = msg.get("content", "")

            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", "")[:100])
                        elif block.get("type") == "image_url":
                            text_parts.append("[IMAGE]")
                content_preview = " | ".join(text_parts)[:200]
            else:
                content_preview = str(content)[:200]

            content_preview = content_preview.replace("\n", "\\n")
            msg_summaries.append(f"[{i}]{role}: {content_preview}...")

        logger.info(
            "[MODEL_INPUT] task_id=%d, subtask_id=%d, msg_count=%d, roles=%s",
            task_id,
            subtask_id,
            len(messages),
            role_counts,
        )
