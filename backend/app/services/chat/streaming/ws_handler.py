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

from langchain_core.tools.base import BaseTool

from app.chat_shell.agent import AgentConfig, ChatAgent
from app.chat_shell.history import get_chat_history
from app.chat_shell.tools.events import create_tool_event_handler
from app.chat_shell.tools.mcp import load_mcp_tools
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
        from app.chat_shell.tools import WebSearchTool
        from app.core.shutdown import shutdown_manager
        from app.services.chat.ws_emitter import get_ws_emitter

        subtask_id = config.subtask_id
        task_id = config.task_id
        task_room = config.task_room

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
            # Register with shutdown manager
            if not await shutdown_manager.register_stream(subtask_id):
                logger.warning(
                    "[WS_STREAM] Rejecting stream during shutdown: subtask_id=%d",
                    subtask_id,
                )
                await emitter.emit_error(subtask_id, "Server is shutting down")
                return

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
                    mcp_client = await load_mcp_tools(
                        task_id, config.bot_name, config.bot_namespace
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
            username = config.get_username_for_message()
            messages = self.agent.build_messages(
                history, message, system_prompt, username=username, config=agent_config
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
            logger.exception("[WS_STREAM] subtask=%s error", subtask_id)
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
