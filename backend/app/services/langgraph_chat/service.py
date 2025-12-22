# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph Chat Service - main service entry point.

This module provides a LangGraph-based chat service that uses:
- LangGraph StateGraph for agent workflow orchestration
- LangChain for model abstraction and tool binding
- Modular streaming infrastructure (SSE and WebSocket)
- Database-based model resolution
- Redis session management

Architecture:
- streaming/: Core streaming logic and emitters
- config/: Chat configuration builders
- agents/: LangGraph agent builders
- messages/: Message conversion utilities
- models/: LangChain model factory
- storage/: Unified storage handler
- tools/: Tool registry and implementations
"""

import json
import logging
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any

from fastapi.responses import StreamingResponse
from langchain_core.tools.base import BaseTool

from app.core.config import settings

from .agents import LangGraphAgentBuilder
from .messages import MessageConverter
from .models import LangChainModelFactory
from .storage import storage_handler
from .streaming import (
    SSEEmitter,
    StreamingConfig,
    StreamingCore,
    StreamingState,
    WebSocketEmitter,
    truncate_list_keep_ends,
)
from .tools import ToolRegistry, WebSearchTool

logger = logging.getLogger(__name__)


@dataclass
class WebSocketStreamConfig:
    """Configuration for WebSocket streaming."""

    task_id: int
    subtask_id: int
    task_room: str
    user_id: int
    user_name: str
    is_group_chat: bool = False
    enable_web_search: bool = False
    search_engine: str | None = None
    extra_tools: list[BaseTool] = field(default_factory=list)


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


class LangGraphChatService:
    """Main service for LangGraph-based chat completions.

    This service uses LangGraph's StateGraph for orchestrating:
    - Model invocation (with tool binding)
    - Tool execution
    - Multi-step reasoning loops
    - Streaming with cancellation support
    - WebSocket streaming for real-time chat

    The service delegates streaming logic to StreamingCore for consistency
    between SSE and WebSocket modes.
    """

    def __init__(
        self,
        workspace_root: str = "/workspace",
        enable_skills: bool = True,
        enable_web_search: bool = False,
        enable_checkpointing: bool = False,
    ):
        """Initialize LangGraph Chat Service.

        Args:
            workspace_root: Root directory for file operations
            enable_skills: Enable built-in file skills
            enable_web_search: Enable web search tool (global default)
            enable_checkpointing: Enable state checkpointing
        """
        self.workspace_root = workspace_root
        self.tool_registry = ToolRegistry()
        self.enable_checkpointing = enable_checkpointing
        self._enable_web_search_default = enable_web_search

        # Register built-in skills
        if enable_skills:
            from .tools.builtin import FileListSkill, FileReaderSkill

            self.tool_registry.register(FileReaderSkill(workspace_root=workspace_root))
            self.tool_registry.register(FileListSkill(workspace_root=workspace_root))

        # Register web search if enabled globally
        if enable_web_search and settings.WEB_SEARCH_ENABLED:
            self.tool_registry.register(WebSearchTool())

    def _create_agent(
        self,
        model_config: dict[str, Any],
        max_iterations: int = 10,
        extra_tools: list[BaseTool] | None = None,
        **model_kwargs,
    ) -> LangGraphAgentBuilder:
        """Create a LangGraph agent with the given model config.

        Args:
            model_config: Model configuration from database
            max_iterations: Max tool loop iterations
            extra_tools: Additional tools to include (e.g., MCP tools)
            **model_kwargs: Additional model parameters

        Returns:
            Configured LangGraphAgentBuilder instance
        """
        # Create LangChain model from config
        llm = LangChainModelFactory.create_from_config(model_config, **model_kwargs)

        # Create a temporary registry with extra tools
        tool_registry = ToolRegistry()

        # Copy existing tools
        for tool in self.tool_registry.get_all():
            tool_registry.register(tool)

        # Add extra tools
        if extra_tools:
            for tool in extra_tools:
                tool_registry.register(tool)

        # Create agent builder
        return LangGraphAgentBuilder(
            llm=llm,
            tool_registry=tool_registry,
            max_iterations=max_iterations,
            enable_checkpointing=self.enable_checkpointing,
        )

    # ==================== SSE Streaming API ====================

    async def chat_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        subtask_id: int | None = None,
        task_id: int | None = None,
        is_group_chat: bool = False,
        max_iterations: int = 10,
    ) -> StreamingResponse:
        """Stream chat response via SSE.

        Uses LangGraph's stream_tokens for token-level streaming.

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
                messages = MessageConverter.build_messages(
                    history=[],
                    current_message=message,
                    system_prompt=system_prompt,
                )

                # Create agent and stream
                agent = self._create_agent(model_config, max_iterations)

                async for token in agent.stream_tokens(messages):
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
    ) -> StreamingResponse:
        """Full streaming with database and session management using StreamingCore."""

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

                # Get chat history
                history = await self._get_chat_history(task_id, is_group_chat)

                # Build messages
                messages = MessageConverter.build_messages(
                    history, message, system_prompt
                )

                # Create agent
                agent = self._create_agent(model_config, max_iterations)

                # Stream tokens
                async for token in agent.stream_tokens(
                    messages, cancel_event=core.cancel_event
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

    # ==================== Non-Streaming API ====================

    async def chat_completion(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        history: list[dict[str, Any]] | None = None,
        max_iterations: int = 10,
    ) -> dict[str, Any]:
        """Non-streaming chat completion using LangGraph agent.

        Args:
            message: User message
            model_config: Model configuration
            system_prompt: System prompt
            history: Optional chat history
            max_iterations: Max tool loop iterations

        Returns:
            Dict with content, tool_results, usage
        """
        messages = MessageConverter.build_messages(
            history=history or [],
            current_message=message,
            system_prompt=system_prompt,
        )

        agent = self._create_agent(model_config, max_iterations)
        final_state = await agent.execute(messages)

        content = agent.get_final_content(final_state)
        error = final_state.get("error")

        if error:
            raise RuntimeError(error)

        return {
            "content": content,
            "tool_results": final_state.get("tool_results", []),
            "iterations": final_state.get("iteration", 0),
        }

    # ==================== WebSocket Streaming API ====================

    async def stream_to_websocket(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        config: WebSocketStreamConfig,
        namespace: Any,
        max_iterations: int = 10,
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
        from app.services.chat.ws_emitter import get_ws_emitter

        subtask_id = config.subtask_id
        task_id = config.task_id
        task_room = config.task_room

        # Create WebSocket emitter
        emitter = WebSocketEmitter(namespace, task_room)

        # Create streaming state
        state = StreamingState(
            task_id=task_id,
            subtask_id=subtask_id,
            user_id=config.user_id,
            user_name=config.user_name,
            is_group_chat=config.is_group_chat,
            enable_web_search=config.enable_web_search,
            search_engine=config.search_engine,
            extra_tools=list(config.extra_tools),
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
                mcp_client = await self._load_mcp_tools(task_id)
                if mcp_client:
                    extra_tools.extend(mcp_client.get_tools())
                    core.set_mcp_client(mcp_client)

            # Add web search tool if enabled for this request
            if config.enable_web_search and settings.WEB_SEARCH_ENABLED:
                extra_tools.append(WebSearchTool())

            # Get chat history
            history = await self._get_chat_history(task_id, config.is_group_chat)

            # Build messages
            messages = MessageConverter.build_messages(history, message, system_prompt)

            # Create agent with extra tools
            agent = self._create_agent(
                model_config, max_iterations, extra_tools=extra_tools
            )

            # Stream tokens
            async for token in agent.stream_tokens(
                messages, cancel_event=core.cancel_event
            ):
                if not await core.process_token(token):
                    # Cancelled or shutdown
                    return

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

    async def _load_mcp_tools(self, task_id: int) -> Any:
        """Load MCP tools for a task.

        Args:
            task_id: Task ID for session management

        Returns:
            MCPClient instance or None
        """
        try:
            from .tools.mcp import MCPClient

            mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
            if not mcp_servers_config:
                return None

            config_data = json.loads(mcp_servers_config)
            servers = config_data.get("mcpServers", config_data)

            if not servers:
                return None

            client = MCPClient(servers)
            await client.connect()
            logger.info(
                "[MCP] Loaded %d tools for task %d",
                len(client.get_tools()),
                task_id,
            )
            return client

        except Exception:
            logger.exception("[MCP] Failed to load MCP tools for task %d", task_id)
            return None

    # ==================== Helper Methods ====================

    async def _get_chat_history(
        self, task_id: int, is_group_chat: bool
    ) -> list[dict[str, Any]]:
        """Get chat history for a task.

        Args:
            task_id: Task ID
            is_group_chat: Whether this is a group chat

        Returns:
            List of message dictionaries
        """
        if is_group_chat:
            history = await self._get_group_chat_history(task_id)
            return self._truncate_history(history)
        return await storage_handler.get_chat_history(task_id)

    async def _get_group_chat_history(self, task_id: int) -> list[dict[str, Any]]:
        """Get chat history for group chat from database."""
        from app.services.chat.chat_service import chat_service

        return await chat_service._get_group_chat_history(task_id)

    def _truncate_history(self, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Truncate chat history keeping first N and last M messages."""
        return truncate_list_keep_ends(
            history,
            settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES,
            settings.GROUP_CHAT_HISTORY_LAST_MESSAGES,
        )

    def list_tools(self) -> list[dict[str, Any]]:
        """List available tools in OpenAI format."""
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": (
                        tool.args_schema.model_json_schema() if tool.args_schema else {}
                    ),
                },
            }
            for tool in self.tool_registry.get_all()
        ]


# Global service instance
langgraph_chat_service = LangGraphChatService(
    workspace_root=getattr(settings, "WORKSPACE_ROOT", "/workspace"),
    enable_skills=getattr(settings, "ENABLE_SKILLS", True),
    enable_web_search=settings.WEB_SEARCH_ENABLED,
    enable_checkpointing=getattr(settings, "ENABLE_CHECKPOINTING", False),
)
