# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Streaming Handler for Chat Service.

This module provides the WebSocket and SSE streaming handlers that:
- Bridge the ChatAgent with streaming infrastructure
- Handle tool event callbacks and thinking steps
- Manage MCP tool loading
- Handle chat history retrieval

The streaming handler is responsible for the streaming workflow while
delegating agent logic to ChatAgent.
"""

import asyncio
import json
import logging
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any

from fastapi.responses import StreamingResponse
from langchain_core.tools.base import BaseTool

from app.core.config import settings
from app.services.streaming import (
    SSEEmitter,
    StreamingConfig,
    StreamingCore,
    StreamingState,
    WebSocketEmitter,
    truncate_list_keep_ends,
)

from .agent import AgentConfig, ChatAgent
from .messages import MessageConverter
from .storage import storage_handler

logger = logging.getLogger(__name__)


@dataclass
class WebSocketStreamConfig:
    """Configuration for WebSocket streaming.

    Attributes:
        task_id: Task ID for the chat session
        subtask_id: Assistant subtask ID
        task_room: WebSocket room name for broadcasting

        user_id: User ID for permission checks and history loading
        user_name: User name for group chat message prefix
        is_group_chat: Whether this is a group chat (affects message prefix and history truncation)

        message_id: Assistant's message_id for frontend ordering
        user_message_id: User's message_id for history exclusion (prevents duplicate messages)

        enable_web_search: Enable web search tool
        search_engine: Specific search engine to use

        bot_name: Bot name for MCP server loading
        bot_namespace: Bot namespace
        shell_type: Shell type (Chat, ClaudeCode, Agno) for frontend display
        extra_tools: Additional tools (e.g., KnowledgeBaseTool)
    """

    # Task identification
    task_id: int
    subtask_id: int
    task_room: str

    # User context
    user_id: int
    user_name: str
    is_group_chat: bool = False

    # Message ordering context
    message_id: int | None = None  # Assistant's message_id for ordering in frontend
    user_message_id: int | None = None  # User's message_id for history exclusion

    # Feature flags
    enable_web_search: bool = False
    search_engine: str | None = None

    # Bot configuration
    bot_name: str = ""
    bot_namespace: str = "default"
    shell_type: str = "Chat"  # Shell type for frontend display
    extra_tools: list[BaseTool] = field(default_factory=list)

    def get_username_for_message(self) -> str | None:
        """Get username for message prefix in group chat mode."""
        return self.user_name if self.is_group_chat else None


# SSE response headers
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
}


def _sse_data(data: dict[str, Any]) -> str:
    """Format data as SSE event."""
    return f"data: {json.dumps(data)}\n\n"


class ChatStreamingHandler:
    """Handler for chat streaming over WebSocket and SSE.

    This class bridges the ChatAgent with streaming infrastructure:
    - Uses ChatAgent for agent execution
    - Uses streaming module for protocol handling
    - Handles tool event callbacks and thinking steps
    - Manages chat history and MCP tools

    The handler is responsible for the streaming workflow while
    delegating agent logic to ChatAgent.
    """

    def __init__(self, agent: ChatAgent):
        """Initialize streaming handler.

        Args:
            agent: ChatAgent instance for agent operations
        """
        self.agent = agent

    # ==================== SSE Streaming API ====================

    async def stream_sse(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        subtask_id: int | None = None,
        task_id: int | None = None,
        is_group_chat: bool = False,
        max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS,
    ) -> StreamingResponse:
        """Stream chat response via SSE.

        Args:
            message: User message (string or dict)
            model_config: Model configuration from ModelResolver
            system_prompt: System prompt
            subtask_id: Subtask ID (None for simple mode)
            task_id: Task ID (None for simple mode)
            is_group_chat: Whether this is a group chat
            max_iterations: Max tool loop iterations

        Returns:
            StreamingResponse with SSE events
        """
        is_simple_mode = subtask_id is None or task_id is None

        if is_simple_mode:
            return await self._simple_stream(
                message, model_config, system_prompt, max_iterations
            )

        return await self._full_stream(
            message=message,
            model_config=model_config,
            system_prompt=system_prompt,
            subtask_id=subtask_id,
            task_id=task_id,
            is_group_chat=is_group_chat,
            max_iterations=max_iterations,
        )

    async def _simple_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        max_iterations: int,
    ) -> StreamingResponse:
        """Simple streaming without database operations."""

        async def generate() -> AsyncGenerator[str, None]:
            try:
                # Build messages
                messages = self.agent.build_messages(
                    history=[],
                    current_message=message,
                    system_prompt=system_prompt,
                )

                # Create agent config and stream
                agent_config = AgentConfig(
                    model_config=model_config,
                    system_prompt=system_prompt,
                    max_iterations=max_iterations,
                )

                async for token in self.agent.stream(messages, agent_config):
                    yield _sse_data({"content": token, "done": False})

                yield _sse_data({"content": "", "done": True})

            except Exception as e:
                logger.exception("Simple stream error")
                yield _sse_data({"error": str(e)})

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    async def _full_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        subtask_id: int,
        task_id: int,
        is_group_chat: bool,
        max_iterations: int,
        user_message_id: int | None = None,
    ) -> StreamingResponse:
        """Full streaming with database and session management using StreamingCore.

        Args:
            user_message_id: Current user's message_id, used to exclude it from history
                            (the user message will be added by build_messages())
        """

        async def generate() -> AsyncGenerator[str, None]:
            # Create SSE emitter
            emitter = SSEEmitter()

            # Create streaming state
            state = StreamingState(
                task_id=task_id,
                subtask_id=subtask_id,
                user_id=0,  # Not needed for SSE
                is_group_chat=is_group_chat,
            )

            # Create streaming core
            core = StreamingCore(emitter, state, StreamingConfig())

            try:
                # Acquire resources
                if not await core.acquire_resources():
                    # Error already emitted by core
                    if emitter.has_events():
                        yield emitter.get_event()
                    return

                # Get chat history (exclude current user message to avoid duplication)
                # The current user message will be added by build_messages()
                history = await self._get_chat_history(
                    task_id, is_group_chat, exclude_after_message_id=user_message_id
                )

                # Build messages
                messages = self.agent.build_messages(history, message, system_prompt)

                # Create agent config
                agent_config = AgentConfig(
                    model_config=model_config,
                    system_prompt=system_prompt,
                    max_iterations=max_iterations,
                )

                # Create tool event handler
                handle_tool_event = self._create_tool_event_handler(
                    state, emitter, self.agent.create_agent_builder(agent_config)
                )

                # Stream tokens
                async for token in self.agent.stream(
                    messages,
                    agent_config,
                    cancel_event=core.cancel_event,
                    on_tool_event=handle_tool_event,
                ):
                    if not await core.process_token(token):
                        # Cancelled
                        if emitter.has_events():
                            yield emitter.get_event()
                        return

                    # Yield any pending events
                    while emitter.has_events():
                        yield emitter.get_event()

                # Finalize
                await core.finalize()

                # Yield final events
                while emitter.has_events():
                    yield emitter.get_event()

            except Exception as e:
                logger.exception("[STREAM] subtask=%s error", subtask_id)
                await core.handle_error(e)
                while emitter.has_events():
                    yield emitter.get_event()

            finally:
                await core.release_resources()

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    # ==================== WebSocket Streaming API ====================

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
        from app.core.shutdown import shutdown_manager
        from app.services.chat_v2.streaming import get_ws_emitter
        from app.services.chat_v2.tools import WebSearchTool

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

            # Prepare extra tools
            extra_tools: list[BaseTool] = list(config.extra_tools)

            # Load MCP tools if enabled
            if settings.CHAT_MCP_ENABLED:
                mcp_client = await self._load_mcp_tools(
                    task_id, config.bot_name, config.bot_namespace
                )
                if mcp_client:
                    extra_tools.extend(mcp_client.get_tools())
                    core.set_mcp_client(mcp_client)

            # Always add web search tool if web search is enabled in settings
            if settings.WEB_SEARCH_ENABLED:
                # Use specified search engine or default to first one
                search_engine = config.search_engine if config.search_engine else None
                extra_tools.append(
                    WebSearchTool(
                        engine_name=search_engine,
                        default_max_results=settings.WEB_SEARCH_DEFAULT_MAX_RESULTS,
                    )
                )

            # Get chat history (exclude current user message to avoid duplication)
            history = await self._get_chat_history(
                task_id,
                config.is_group_chat,
                exclude_after_message_id=config.user_message_id,
            )

            # Build messages
            username = config.get_username_for_message()
            messages = self.agent.build_messages(
                history, message, system_prompt, username=username
            )

            # Log messages sent to model for debugging
            self._log_messages_for_debug(task_id, subtask_id, messages)

            # Find LoadSkillTool from extra_tools for dynamic skill prompt injection
            load_skill_tool = None
            for tool in extra_tools:
                if tool.name == "load_skill":
                    load_skill_tool = tool
                    logger.info(
                        "[WS_STREAM] Found LoadSkillTool for dynamic skill prompt injection"
                    )
                    break

            # Create agent config
            agent_config = AgentConfig(
                model_config=model_config,
                system_prompt=system_prompt,
                max_iterations=max_iterations,
                extra_tools=extra_tools,
                load_skill_tool=load_skill_tool,
            )

            # Create agent builder for tool event handler
            agent_builder = self.agent.create_agent_builder(agent_config)

            logger.info(
                "[WS_STREAM] Starting token streaming: task_id=%d, subtask_id=%d, tools=%d",
                task_id,
                subtask_id,
                len(extra_tools),
            )

            # Create tool event handler
            handle_tool_event = self._create_tool_event_handler(
                state, emitter, agent_builder
            )

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

    # ==================== Helper Methods ====================

    def _create_tool_event_handler(
        self,
        state: StreamingState,
        emitter: Any,
        agent_builder: Any,
    ):
        """Create a tool event handler function.

        Args:
            state: Streaming state to update
            emitter: Stream emitter for events
            agent_builder: Agent builder for tool registry access

        Returns:
            Tool event handler function
        """

        def handle_tool_event(kind: str, event_data: dict):
            """Handle tool events and add thinking steps."""
            tool_name = event_data.get("name", "unknown")
            run_id = event_data.get("run_id", "")

            if kind == "tool_start":
                self._handle_tool_start(
                    state, emitter, agent_builder, tool_name, run_id, event_data
                )
            elif kind == "tool_end":
                self._handle_tool_end(
                    state, emitter, agent_builder, tool_name, run_id, event_data
                )

        return handle_tool_event

    def _handle_tool_start(
        self,
        state: StreamingState,
        emitter: Any,
        agent_builder: Any,
        tool_name: str,
        run_id: str,
        event_data: dict,
    ):
        """Handle tool start event."""
        # Extract tool input for better display
        tool_input = event_data.get("data", {}).get("input", {})

        # Convert input to JSON-serializable format
        serializable_input = self._make_serializable(tool_input)

        # Build friendly title
        title = self._build_tool_start_title(
            agent_builder, tool_name, serializable_input
        )

        state.add_thinking_step(
            {
                "title": title,
                "next_action": "continue",
                "run_id": run_id,
                "details": {
                    "type": "tool_use",
                    "tool_name": tool_name,
                    "name": tool_name,
                    "status": "started",
                    "input": serializable_input,
                },
            }
        )

        # Immediately emit thinking step
        asyncio.create_task(
            emitter.emit_chunk(
                content="",
                offset=state.offset,
                subtask_id=state.subtask_id,
                result=state.get_current_result(),
            )
        )

    def _handle_tool_end(
        self,
        state: StreamingState,
        emitter: Any,
        agent_builder: Any,
        tool_name: str,
        run_id: str,
        event_data: dict,
    ):
        """Handle tool end event."""
        # Extract and serialize tool output
        tool_output = event_data.get("data", {}).get("output", "")
        serializable_output = self._make_output_serializable(tool_output)

        # Process tool output and extract metadata
        title, sources = self.agent.process_tool_output(tool_name, serializable_output)

        # Add sources to state
        if sources:
            state.add_sources(sources)

        # Try to get better title from display_name
        if title == f"Tool completed: {tool_name}":
            title = self._build_tool_end_title(
                agent_builder, tool_name, run_id, state, title
            )

        # Find matching start step and insert result after it
        matching_start_idx = None
        for idx, step in enumerate(state.thinking):
            if (
                step.get("run_id") == run_id
                and step.get("details", {}).get("status") == "started"
            ):
                matching_start_idx = idx
                break

        result_step = {
            "title": title,
            "next_action": "continue",
            "run_id": run_id,
            "details": {
                "type": "tool_result",
                "tool_name": tool_name,
                "status": "completed",
                "output": serializable_output,
                "content": serializable_output,
            },
        }

        if matching_start_idx is not None:
            state.thinking.insert(matching_start_idx + 1, result_step)
        else:
            state.add_thinking_step(result_step)

        # Immediately emit thinking step
        asyncio.create_task(
            emitter.emit_chunk(
                content="",
                offset=state.offset,
                subtask_id=state.subtask_id,
                result=state.get_current_result(),
            )
        )

    def _make_serializable(self, value: Any) -> Any:
        """Convert value to JSON-serializable format."""
        if isinstance(value, dict):
            result = {}
            for key, val in value.items():
                if isinstance(val, (str, dict, list, int, float, bool, type(None))):
                    result[key] = val
                else:
                    result[key] = str(val)
            return result
        elif isinstance(value, (str, list, int, float, bool, type(None))):
            return value
        else:
            return str(value)

    def _make_output_serializable(self, tool_output: Any) -> Any:
        """Convert tool output to JSON-serializable format."""
        if hasattr(tool_output, "content"):
            return tool_output.content
        elif not isinstance(
            tool_output, (str, dict, list, int, float, bool, type(None))
        ):
            return str(tool_output)
        return tool_output

    def _build_tool_start_title(
        self,
        agent_builder: Any,
        tool_name: str,
        serializable_input: Any,
    ) -> str:
        """Build friendly title for tool start event."""
        tool_instance = None
        if agent_builder.tool_registry:
            tool_instance = agent_builder.tool_registry.get(tool_name)

        display_name = (
            getattr(tool_instance, "display_name", None) if tool_instance else None
        )

        if display_name:
            title = display_name
            # For load_skill, append the skill's friendly display name
            if tool_name == "load_skill" and tool_instance:
                skill_name_param = (
                    serializable_input.get("skill_name", "")
                    if isinstance(serializable_input, dict)
                    else ""
                )
                if skill_name_param:
                    skill_display = skill_name_param
                    if hasattr(tool_instance, "get_skill_display_name"):
                        try:
                            skill_display = tool_instance.get_skill_display_name(
                                skill_name_param
                            )
                        except Exception:
                            pass
                    title = f"{display_name}：{skill_display}"
        elif tool_name == "web_search":
            query = (
                serializable_input if isinstance(serializable_input, dict) else {}
            ).get("query", "")
            title = f"正在搜索: {query}" if query else "正在进行网页搜索"
        else:
            title = f"正在使用工具: {tool_name}"

        return title

    def _build_tool_end_title(
        self,
        agent_builder: Any,
        tool_name: str,
        run_id: str,
        state: StreamingState,
        default_title: str,
    ) -> str:
        """Build friendly title for tool end event."""
        tool_instance = None
        if agent_builder.tool_registry:
            tool_instance = agent_builder.tool_registry.get(tool_name)

        display_name = (
            getattr(tool_instance, "display_name", None) if tool_instance else None
        )

        if not display_name:
            return default_title

        # Remove "正在" prefix for cleaner display
        if display_name.startswith("正在"):
            base_title = display_name[2:]
        else:
            base_title = display_name

        # For load_skill, append the skill's friendly display name
        if tool_name == "load_skill" and tool_instance:
            # Find the matching tool_start step to get the skill_name
            for step in state.thinking:
                if (
                    step.get("run_id") == run_id
                    and step.get("details", {}).get("status") == "started"
                ):
                    start_input = step.get("details", {}).get("input", {})
                    if isinstance(start_input, dict):
                        skill_name_param = start_input.get("skill_name", "")
                        if skill_name_param and hasattr(
                            tool_instance, "get_skill_display_name"
                        ):
                            skill_display = tool_instance.get_skill_display_name(
                                skill_name_param
                            )
                            return f"{base_title}：{skill_display}"
                    break

        return base_title

    async def _load_mcp_tools(
        self, task_id: int, bot_name: str = "", bot_namespace: str = "default"
    ) -> Any:
        """Load MCP tools for a task.

        See ChatService._load_mcp_tools for full documentation.
        """
        try:
            from app.services.chat_v2.tools.mcp import MCPClient

            # Step 1: Load backend MCP configuration
            backend_servers = {}
            mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
            if mcp_servers_config:
                try:
                    config_data = json.loads(mcp_servers_config)
                    backend_servers = config_data.get("mcpServers", config_data)
                except json.JSONDecodeError as e:
                    logger.warning("[MCP] Failed to parse CHAT_MCP_SERVERS: %s", str(e))

            # Step 2: Load bot's MCP configuration from Ghost CRD
            bot_servers = {}
            if bot_name and bot_namespace:
                try:
                    bot_servers = await asyncio.wait_for(
                        self._get_bot_mcp_servers(bot_name, bot_namespace), timeout=5.0
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "[MCP] Timeout querying bot MCP servers for %s/%s",
                        bot_namespace,
                        bot_name,
                    )
                except Exception as e:
                    logger.warning(
                        "[MCP] Failed to load bot MCP servers for %s/%s: %s",
                        bot_namespace,
                        bot_name,
                        str(e),
                    )

            # Step 3: Merge configurations (bot config takes precedence)
            merged_servers = {**backend_servers, **bot_servers}

            if not merged_servers:
                return None

            logger.info(
                "[MCP] Merged MCP configuration: %d servers for task %d",
                len(merged_servers),
                task_id,
            )

            # Step 4: Create MCP client with merged configuration
            client = MCPClient(merged_servers)
            try:
                await asyncio.wait_for(client.connect(), timeout=30.0)
                logger.info(
                    "[MCP] Loaded %d tools from %d MCP servers for task %d",
                    len(client.get_tools()),
                    len(merged_servers),
                    task_id,
                )
                return client
            except asyncio.TimeoutError:
                logger.error(
                    "[MCP] Timeout connecting to MCP servers for task %d", task_id
                )
                return None
            except Exception as e:
                logger.error(
                    "[MCP] Failed to connect to MCP servers for task %d: %s",
                    task_id,
                    str(e),
                )
                return None

        except Exception:
            logger.exception(
                "[MCP] Unexpected error loading MCP tools for task %d", task_id
            )
            return None

    async def _get_bot_mcp_servers(
        self, bot_name: str, bot_namespace: str
    ) -> dict[str, Any]:
        """Query bot's Ghost CRD to get MCP server configuration."""
        return await asyncio.to_thread(
            self._get_bot_mcp_servers_sync, bot_name, bot_namespace
        )

    def _get_bot_mcp_servers_sync(
        self, bot_name: str, bot_namespace: str
    ) -> dict[str, Any]:
        """Synchronous implementation of bot MCP servers query."""
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
                "[MCP] Failed to query bot MCP servers for %s/%s",
                bot_namespace,
                bot_name,
            )
            return {}
        finally:
            db.close()

    async def _get_chat_history(
        self,
        task_id: int,
        is_group_chat: bool,
        exclude_after_message_id: int | None = None,
    ) -> list[dict[str, Any]]:
        """Get chat history for a task directly from database.

        Args:
            task_id: Task ID
            is_group_chat: Whether to include username prefix in user messages
            exclude_after_message_id: If provided, exclude messages with message_id >= this value.

        Returns:
            List of message dictionaries
        """
        history = await self._load_history_from_db(
            task_id, is_group_chat, exclude_after_message_id
        )
        # Only truncate history for group chat
        if is_group_chat:
            return self._truncate_history(history)
        return history

    async def _load_history_from_db(
        self,
        task_id: int,
        is_group_chat: bool,
        exclude_after_message_id: int | None = None,
    ) -> list[dict[str, Any]]:
        """Load chat history from database."""
        return await asyncio.to_thread(
            self._load_history_from_db_sync,
            task_id,
            is_group_chat,
            exclude_after_message_id,
        )

    def _load_history_from_db_sync(
        self,
        task_id: int,
        is_group_chat: bool,
        exclude_after_message_id: int | None = None,
    ) -> list[dict[str, Any]]:
        """Synchronous implementation of chat history retrieval."""
        from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
        from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment
        from app.models.user import User
        from app.services.attachment import attachment_service
        from app.services.chat_v2.storage.db import _db_session

        history: list[dict[str, Any]] = []
        with _db_session() as db:
            query = (
                db.query(Subtask, User.user_name)
                .outerjoin(User, Subtask.sender_user_id == User.id)
                .filter(
                    Subtask.task_id == task_id,
                    Subtask.status == SubtaskStatus.COMPLETED,
                )
            )

            if exclude_after_message_id is not None:
                query = query.filter(Subtask.message_id < exclude_after_message_id)

            subtasks = query.order_by(Subtask.message_id.asc()).all()

            for subtask, sender_username in subtasks:
                msg = self._build_history_message(
                    db, subtask, sender_username, attachment_service, is_group_chat
                )
                if msg:
                    history.append(msg)

        return history

    def _build_history_message(
        self,
        db,
        subtask,
        sender_username: str | None,
        attachment_service,
        is_group_chat: bool = False,
    ) -> dict[str, Any] | None:
        """Build a single history message from a subtask."""
        from app.models.subtask import SubtaskRole
        from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment

        if subtask.role == SubtaskRole.USER:
            # Build text content
            text_content = subtask.prompt or ""
            if is_group_chat and sender_username:
                text_content = f"User[{sender_username}]: {text_content}"

            # Get attachments
            attachments = (
                db.query(SubtaskAttachment)
                .filter(
                    SubtaskAttachment.subtask_id == subtask.id,
                    SubtaskAttachment.status == AttachmentStatus.READY,
                )
                .all()
            )

            if not attachments:
                return {"role": "user", "content": text_content}

            # Process attachments
            vision_parts: list[dict[str, Any]] = []
            for attachment in attachments:
                vision_block = attachment_service.build_vision_content_block(attachment)
                if vision_block:
                    vision_parts.append(vision_block)
                else:
                    doc_prefix = attachment_service.build_document_text_prefix(
                        attachment
                    )
                    if doc_prefix:
                        text_content = f"{doc_prefix}{text_content}"

            if vision_parts:
                return {
                    "role": "user",
                    "content": [{"type": "text", "text": text_content}, *vision_parts],
                }
            return {"role": "user", "content": text_content}

        elif subtask.role == SubtaskRole.ASSISTANT:
            if not subtask.result or not isinstance(subtask.result, dict):
                return None
            content = subtask.result.get("value", "")
            return {"role": "assistant", "content": content} if content else None

        return None

    def _truncate_history(self, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Truncate chat history keeping first N and last M messages."""
        return truncate_list_keep_ends(
            history,
            settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES,
            settings.GROUP_CHAT_HISTORY_LAST_MESSAGES,
        )

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
