# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Service - main service entry point.

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

import asyncio
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


class ChatService:
    """Main service for chat completions.

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
        enable_skills: bool = False,
        enable_web_search: bool = False,
        enable_checkpointing: bool = False,
    ):
        """Initialize Chat Service.

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
            self.tool_registry.register(
                WebSearchTool(
                    default_max_results=settings.WEB_SEARCH_DEFAULT_MAX_RESULTS
                )
            )

    def _create_agent(
        self,
        model_config: dict[str, Any],
        max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS,
        extra_tools: list[BaseTool] | None = None,
        streaming: bool = True,
        **model_kwargs,
    ) -> LangGraphAgentBuilder:
        """Create a LangGraph agent with the given model config.

        Args:
            model_config: Model configuration from database
            max_iterations: Max tool loop iterations
            extra_tools: Additional tools to include (e.g., MCP tools)
            streaming: Enable streaming mode for the model (default: True)
            **model_kwargs: Additional model parameters

        Returns:
            Configured LangGraphAgentBuilder instance
        """
        # Create LangChain model from config with streaming enabled
        llm = LangChainModelFactory.create_from_config(
            model_config, streaming=streaming, **model_kwargs
        )

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

    def _process_tool_output(
        self, tool_name: str, serializable_output: Any, state: StreamingState
    ) -> str:
        """Process tool output and extract metadata like sources.

        This method handles tool-specific output processing in a unified way:
        - Parses JSON output if needed
        - Extracts metadata (sources, count, etc.)
        - Updates streaming state with metadata
        - Returns a friendly title for display

        Args:
            tool_name: Name of the tool
            serializable_output: Tool output (string or dict)
            state: Streaming state to update with metadata

        Returns:
            Friendly title for the tool completion
        """
        # Default title
        title = f"Tool completed: {tool_name}"

        if not serializable_output:
            return title

        try:
            # Parse output to dict if it's a JSON string
            output_data = (
                json.loads(serializable_output)
                if isinstance(serializable_output, str)
                else serializable_output
            )

            if not isinstance(output_data, dict):
                return title

            # Extract common fields
            count = output_data.get("count", 0)
            sources = output_data.get("sources", [])

            # Add sources to state if present (for knowledge base and similar tools)
            if sources:
                state.add_sources(sources)
                logger.info(
                    "[TOOL_OUTPUT] Added %d sources from %s", len(sources), tool_name
                )

            # Build tool-specific friendly titles
            if tool_name == "web_search":
                if count > 0:
                    title = f"Found {count} search results"
                else:
                    title = "No search results found"
            elif tool_name == "knowledge_base_search":
                if count > 0:
                    title = f"Retrieved {count} items from knowledge base"
                else:
                    title = "No relevant information found in knowledge base"
            else:
                # Generic title for other tools with count
                if count > 0:
                    title = f"{tool_name}: {count} results"

        except Exception as e:
            logger.warning(
                "[TOOL_OUTPUT] Failed to process output for %s: %s", tool_name, str(e)
            )

        return title

    # ==================== SSE Streaming API ====================

    async def chat_stream(
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
                messages = MessageConverter.build_messages(
                    history, message, system_prompt
                )

                # Create agent
                agent = self._create_agent(model_config, max_iterations)

                # Define tool event handler to capture thinking steps
                def handle_tool_event(kind: str, event_data: dict):
                    """Handle tool events and add thinking steps."""
                    tool_name = event_data.get("name", "unknown")
                    run_id = event_data.get("run_id", "")

                    if kind == "tool_start":
                        # Extract tool input for better display
                        tool_input = event_data.get("data", {}).get("input", {})

                        # Convert input to JSON-serializable format
                        # LangGraph may pass ToolRuntime or other non-serializable objects
                        serializable_input = {}
                        if isinstance(tool_input, dict):
                            for key, value in tool_input.items():
                                if isinstance(
                                    value,
                                    (str, dict, list, int, float, bool, type(None)),
                                ):
                                    serializable_input[key] = value
                                else:
                                    # Convert non-serializable objects to string
                                    serializable_input[key] = str(value)
                        elif isinstance(
                            tool_input, (str, list, int, float, bool, type(None))
                        ):
                            serializable_input = tool_input
                        else:
                            serializable_input = str(tool_input)

                        # Build friendly title based on tool type
                        if tool_name == "web_search":
                            query = (
                                serializable_input
                                if isinstance(serializable_input, dict)
                                else {}
                            ).get("query", "")
                            title = (
                                f"正在搜索: {query}" if query else "正在进行网页搜索"
                            )
                        else:
                            title = f"正在使用工具: {tool_name}"

                        state.add_thinking_step(
                            {
                                "title": title,
                                "next_action": "continue",
                                "run_id": run_id,  # Track run_id for pairing
                                "details": {
                                    "type": "tool_use",
                                    "tool_name": tool_name,
                                    "name": tool_name,  # Frontend expects 'name' field
                                    "status": "started",
                                    "input": serializable_input,
                                },
                            }
                        )
                        # Immediately emit thinking step via SSE
                        asyncio.create_task(
                            emitter.emit_chunk(
                                content="",
                                offset=state.offset,
                                subtask_id=state.subtask_id,
                                result=state.get_current_result(),
                            )
                        )
                    elif kind == "tool_end":
                        # Extract tool output for better display
                        tool_output = event_data.get("data", {}).get("output", "")

                        # Convert output to JSON-serializable format
                        # LangGraph may return ToolMessage objects which are not JSON serializable
                        serializable_output = tool_output
                        if hasattr(tool_output, "content"):
                            # It's a LangChain message object, extract content
                            serializable_output = tool_output.content
                        elif not isinstance(
                            tool_output, (str, dict, list, int, float, bool, type(None))
                        ):
                            # Try to convert to string for other non-serializable types
                            serializable_output = str(tool_output)

                        # Process tool output and extract metadata (sources, etc.)
                        title = self._process_tool_output(
                            tool_name, serializable_output, state
                        )

                        # Find the matching tool_start step by run_id and update it
                        # This ensures start and end are displayed together in order
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
                                "output": serializable_output,  # Keep for backward compatibility
                                "content": serializable_output,  # Frontend expects 'content' field
                            },
                        }

                        # Insert result right after its corresponding start
                        if matching_start_idx is not None:
                            state.thinking.insert(matching_start_idx + 1, result_step)
                        else:
                            # Fallback: append if no matching start found
                            state.add_thinking_step(result_step)

                        # Immediately emit thinking step via SSE
                        asyncio.create_task(
                            emitter.emit_chunk(
                                content="",
                                offset=state.offset,
                                subtask_id=state.subtask_id,
                                result=state.get_current_result(),
                            )
                        )

                # Stream tokens
                async for token in agent.stream_tokens(
                    messages,
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

    # ==================== Non-Streaming API ====================

    async def chat_completion(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        history: list[dict[str, Any]] | None = None,
        max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS,
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
            enable_web_search=config.enable_web_search,
            search_engine=config.search_engine,
            extra_tools=list(config.extra_tools),
            message_id=config.message_id,
            shell_type=config.shell_type,  # Pass shell_type from config
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
            # Regardless of frontend enable_web_search toggle
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
            # The current user message will be added by build_messages()
            history = await self._get_chat_history(
                task_id,
                config.is_group_chat,
                exclude_after_message_id=config.user_message_id,
            )

            # Build messages
            # For group chat, add username prefix to current message so model knows who sent it
            username = config.get_username_for_message()
            messages = MessageConverter.build_messages(
                history, message, system_prompt, username=username
            )

            # Log messages sent to model for debugging
            self._log_messages_for_debug(task_id, subtask_id, messages)

            # Create agent with extra tools
            agent = self._create_agent(
                model_config, max_iterations, extra_tools=extra_tools
            )

            logger.info(
                "[WS_STREAM] Starting token streaming: task_id=%d, subtask_id=%d, tools=%d",
                task_id,
                subtask_id,
                len(extra_tools),
            )

            # Define tool event handler to capture thinking steps
            def handle_tool_event(kind: str, event_data: dict):
                """Handle tool events and add thinking steps."""
                tool_name = event_data.get("name", "unknown")
                run_id = event_data.get("run_id", "")

                if kind == "tool_start":
                    # Extract tool input for better display
                    tool_input = event_data.get("data", {}).get("input", {})

                    # Convert input to JSON-serializable format
                    # LangGraph may pass ToolRuntime or other non-serializable objects
                    serializable_input = {}
                    if isinstance(tool_input, dict):
                        for key, value in tool_input.items():
                            if isinstance(
                                value, (str, dict, list, int, float, bool, type(None))
                            ):
                                serializable_input[key] = value
                            else:
                                # Convert non-serializable objects to string
                                serializable_input[key] = str(value)
                    elif isinstance(
                        tool_input, (str, list, int, float, bool, type(None))
                    ):
                        serializable_input = tool_input
                    else:
                        serializable_input = str(tool_input)

                    # Build friendly title based on tool type
                    if tool_name == "web_search":
                        query = (
                            serializable_input
                            if isinstance(serializable_input, dict)
                            else {}
                        ).get("query", "")
                        title = f"正在搜索: {query}" if query else "正在进行网页搜索"
                    else:
                        title = f"正在使用工具: {tool_name}"

                    state.add_thinking_step(
                        {
                            "title": title,
                            "next_action": "continue",
                            "run_id": run_id,  # Track run_id for pairing
                            "details": {
                                "type": "tool_use",
                                "tool_name": tool_name,
                                "name": tool_name,  # Frontend expects 'name' field
                                "status": "started",
                                "input": serializable_input,
                            },
                        }
                    )
                    # Immediately emit thinking step via WebSocket
                    asyncio.create_task(
                        emitter.emit_chunk(
                            content="",
                            offset=state.offset,
                            subtask_id=state.subtask_id,
                            result=state.get_current_result(),
                        )
                    )
                elif kind == "tool_end":
                    # Extract tool output for better display
                    tool_output = event_data.get("data", {}).get("output", "")

                    # Convert output to JSON-serializable format
                    # LangGraph may return ToolMessage objects which are not JSON serializable
                    serializable_output = tool_output
                    if hasattr(tool_output, "content"):
                        # It's a LangChain message object, extract content
                        serializable_output = tool_output.content
                    elif not isinstance(
                        tool_output, (str, dict, list, int, float, bool, type(None))
                    ):
                        # Try to convert to string for other non-serializable types
                        serializable_output = str(tool_output)

                    # Process tool output and extract metadata (sources, etc.)
                    title = self._process_tool_output(
                        tool_name, serializable_output, state
                    )

                    # Find the matching tool_start step by run_id and update it
                    # This ensures start and end are displayed together in order
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
                            "output": serializable_output,  # Keep for backward compatibility
                            "content": serializable_output,  # Frontend expects 'content' field
                        },
                    }

                    # Insert result right after its corresponding start
                    if matching_start_idx is not None:
                        state.thinking.insert(matching_start_idx + 1, result_step)
                    else:
                        # Fallback: append if no matching start found
                        state.add_thinking_step(result_step)

                    # Immediately emit thinking step via WebSocket
                    asyncio.create_task(
                        emitter.emit_chunk(
                            content="",
                            offset=state.offset,
                            subtask_id=state.subtask_id,
                            result=state.get_current_result(),
                        )
                    )

            # Stream tokens
            token_count = 0
            async for token in agent.stream_tokens(
                messages,
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

    async def _load_mcp_tools(
        self, task_id: int, bot_name: str = "", bot_namespace: str = "default"
    ) -> Any:
        """Load MCP tools for a task, merging backend and bot configurations.

        This method combines MCP server configurations from two sources:
        1. Backend environment variable (CHAT_MCP_SERVERS) - global configuration
        2. Bot's Ghost CRD (ghost.spec.mcpServers) - bot-specific configuration

        If a server name exists in both configurations, the bot's configuration
        takes precedence to allow per-bot customization.

        Protection mechanisms:
        - Timeout protection: MCP connection with timeout (30s default)
        - Exception isolation: All MCP errors are caught and logged
        - Graceful degradation: Returns None on failure, chat continues without MCP tools

        Args:
            task_id: Task ID for session management
            bot_name: Bot name to query Ghost MCP configuration
            bot_namespace: Bot namespace for Ghost query

        Returns:
            MCPClient instance or None (None on any failure to protect backend stability)
        """
        try:
            from .tools.mcp import MCPClient

            # Step 1: Load backend MCP configuration
            backend_servers = {}
            mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
            if mcp_servers_config:
                try:
                    config_data = json.loads(mcp_servers_config)
                    backend_servers = config_data.get("mcpServers", config_data)
                    if backend_servers:
                        logger.info(
                            "[MCP] Loaded %d backend MCP servers from CHAT_MCP_SERVERS",
                            len(backend_servers),
                        )
                except json.JSONDecodeError as e:
                    logger.warning("[MCP] Failed to parse CHAT_MCP_SERVERS: %s", str(e))

            # Step 2: Load bot's MCP configuration from Ghost CRD
            bot_servers = {}
            if bot_name and bot_namespace:
                try:
                    bot_servers = await asyncio.wait_for(
                        self._get_bot_mcp_servers(bot_name, bot_namespace), timeout=5.0
                    )
                    if bot_servers:
                        logger.info(
                            "[MCP] Loaded %d bot MCP servers from Ghost %s/%s",
                            len(bot_servers),
                            bot_namespace,
                            bot_name,
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
                logger.info(
                    "[MCP] No MCP servers configured for task %d (bot=%s/%s)",
                    task_id,
                    bot_namespace,
                    bot_name,
                )
                return None

            logger.info(
                "[MCP] Merged MCP configuration: %d servers (backend=%d, bot=%d, merged=%d) for task %d",
                len(merged_servers),
                len(backend_servers),
                len(bot_servers),
                len(merged_servers),
                task_id,
            )

            # Step 4: Create MCP client with merged configuration
            # Add timeout protection for MCP connection
            client = MCPClient(merged_servers)
            try:
                # Timeout for connecting to MCP servers (30 seconds)
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
                    "[MCP] Timeout connecting to MCP servers for task %d (bot=%s/%s)",
                    task_id,
                    bot_namespace,
                    bot_name,
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
            # Catch all exceptions to protect backend stability
            # MCP tool loading should NEVER crash the chat service
            logger.exception(
                "[MCP] Unexpected error loading MCP tools for task %d (bot=%s/%s)",
                task_id,
                bot_namespace,
                bot_name,
            )
            return None

    async def _get_bot_mcp_servers(
        self, bot_name: str, bot_namespace: str
    ) -> dict[str, Any]:
        """Query bot's Ghost CRD to get MCP server configuration.

        Args:
            bot_name: Bot name
            bot_namespace: Bot namespace

        Returns:
            Dictionary of MCP servers from ghost.spec.mcpServers, or empty dict
        """
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
                logger.debug(
                    "[MCP] Bot %s/%s not found or has no JSON", bot_namespace, bot_name
                )
                return {}

            # Parse Bot CRD to get ghostRef
            bot_crd = Bot.model_validate(bot_kind.json)
            if not bot_crd.spec or not bot_crd.spec.ghostRef:
                logger.debug("[MCP] Bot %s/%s has no ghostRef", bot_namespace, bot_name)
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
                logger.debug(
                    "[MCP] Ghost %s/%s not found or has no JSON",
                    ghost_namespace,
                    ghost_name,
                )
                return {}

            # Parse Ghost CRD to get mcpServers
            ghost_crd = Ghost.model_validate(ghost_kind.json)
            if not ghost_crd.spec or not ghost_crd.spec.mcpServers:
                logger.debug(
                    "[MCP] Ghost %s/%s has no mcpServers", ghost_namespace, ghost_name
                )
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

    # ==================== Helper Methods ====================

    async def _get_chat_history(
        self,
        task_id: int,
        is_group_chat: bool,
        exclude_after_message_id: int | None = None,
    ) -> list[dict[str, Any]]:
        """Get chat history for a task directly from database.

        Always reads from database to ensure data consistency.
        Database is the single source of truth for chat history.

        Args:
            task_id: Task ID
            is_group_chat: Whether to include username prefix in user messages
            exclude_after_message_id: If provided, exclude messages with message_id >= this value.
                                      Pass the current user's message_id to exclude it from history
                                      (the user message will be added by build_messages()).

        Returns:
            List of message dictionaries
        """
        history = await self._load_history_from_db(
            task_id, is_group_chat, exclude_after_message_id
        )
        # Only truncate history for group chat to limit context size
        # Single chat keeps full history for better conversation continuity
        if is_group_chat:
            return self._truncate_history(history)
        return history

    async def _load_history_from_db(
        self,
        task_id: int,
        is_group_chat: bool,
        exclude_after_message_id: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Load chat history from database.

        Args:
            task_id: Task ID
            is_group_chat: Whether to include username prefix in user messages
            exclude_after_message_id: If provided, exclude messages with message_id >= this value

        Returns:
            List of message dictionaries with role and content
        """
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
        """Synchronous implementation of chat history retrieval from database.

        Args:
            task_id: Task ID
            is_group_chat: Whether to include username prefix in user messages
            exclude_after_message_id: If provided, exclude messages with message_id >= this value
        """
        from app.models.subtask import Subtask, SubtaskStatus
        from app.models.user import User
        from app.services.attachment import attachment_service
        from app.services.chat_v2.storage.db import _db_session

        history: list[dict[str, Any]] = []
        with _db_session() as db:
            # Build base query
            query = (
                db.query(Subtask, User.user_name)
                .outerjoin(User, Subtask.sender_user_id == User.id)
                .filter(
                    Subtask.task_id == task_id,
                    Subtask.status == SubtaskStatus.COMPLETED,
                )
            )

            # Exclude current and future messages to avoid duplicates
            # The current user message will be added by build_messages()
            if exclude_after_message_id is not None:
                query = query.filter(Subtask.message_id < exclude_after_message_id)

            subtasks = query.order_by(Subtask.message_id.asc()).all()

            logger.info(
                f"[CHAT_HISTORY] task_id={task_id}, is_group_chat={is_group_chat}, "
                f"exclude_after_message_id={exclude_after_message_id}, "
                f"completed_subtasks={len(subtasks)}"
            )

            for subtask, sender_username in subtasks:
                msg = self._build_history_message(
                    db, subtask, sender_username, attachment_service, is_group_chat
                )
                if msg:
                    history.append(msg)
                    logger.debug(
                        f"[CHAT_HISTORY] Added message: role={msg.get('role')}, "
                        f"content_preview={str(msg.get('content', ''))[:100]}..."
                    )

        logger.info(
            f"[CHAT_HISTORY] task_id={task_id}, "
            f"final_history_count={len(history)}, "
            f"history_roles=[{', '.join([m.get('role', 'unknown') for m in history])}]"
        )
        return history

    def _build_history_message(
        self,
        db,
        subtask,
        sender_username: str | None,
        attachment_service,
        is_group_chat: bool = False,
    ) -> dict[str, Any] | None:
        """Build a single history message from a subtask.

        Args:
            db: Database session
            subtask: Subtask object
            sender_username: Username of the sender (for group chat)
            attachment_service: Attachment service for processing attachments
            is_group_chat: Whether to include username prefix in user messages
        """
        from app.models.subtask import SubtaskRole

        if subtask.role == SubtaskRole.USER:
            return self._build_user_message(
                db, subtask, sender_username, attachment_service, is_group_chat
            )
        elif subtask.role == SubtaskRole.ASSISTANT:
            return self._build_assistant_message(subtask)
        return None

    def _build_user_message(
        self,
        db,
        subtask,
        sender_username: str | None,
        attachment_service,
        is_group_chat: bool = False,
    ) -> dict[str, Any]:
        """Build a user message with optional attachments.

        Args:
            db: Database session
            subtask: Subtask object
            sender_username: Username of the sender
            attachment_service: Attachment service for processing attachments
            is_group_chat: Whether to include username prefix (only for group chat)
        """
        from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment

        # Build text content, optionally with username prefix for group chat
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
                doc_prefix = attachment_service.build_document_text_prefix(attachment)
                if doc_prefix:
                    text_content = f"{doc_prefix}{text_content}"

        # Build final content
        if vision_parts:
            return {
                "role": "user",
                "content": [{"type": "text", "text": text_content}, *vision_parts],
            }
        return {"role": "user", "content": text_content}

    def _build_assistant_message(self, subtask) -> dict[str, Any] | None:
        """Build an assistant message from subtask result."""
        if not subtask.result or not isinstance(subtask.result, dict):
            return None
        content = subtask.result.get("value", "")
        return {"role": "assistant", "content": content} if content else None

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
        """Log messages sent to model for debugging purposes.

        Logs a summary of messages including:
        - Total message count
        - Role distribution
        - Content preview for each message (truncated)

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            messages: List of message dicts to be sent to model
        """
        if not messages:
            logger.info(
                "[MODEL_INPUT] task_id=%d, subtask_id=%d, messages=[]",
                task_id,
                subtask_id,
            )
            return

        # Count roles
        role_counts = {}
        for msg in messages:
            role = msg.get("role", "unknown")
            role_counts[role] = role_counts.get(role, 0) + 1

        # Build message summaries with truncated content
        msg_summaries = []
        for i, msg in enumerate(messages):
            role = msg.get("role", "unknown")
            content = msg.get("content", "")

            # Handle content that might be a list (vision messages)
            if isinstance(content, list):
                # Extract text from content blocks
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

            # Replace newlines for cleaner log output
            content_preview = content_preview.replace("\n", "\\n")
            msg_summaries.append(f"[{i}]{role}: {content_preview}...")

        logger.info(
            "[MODEL_INPUT] task_id=%d, subtask_id=%d, msg_count=%d, roles=%s, "
            "messages=[\n  %s\n]",
            task_id,
            subtask_id,
            len(messages),
            role_counts,
            "\n  ".join(msg_summaries),
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
chat_service = ChatService(
    workspace_root=getattr(settings, "WORKSPACE_ROOT", "/workspace"),
    enable_skills=getattr(settings, "ENABLE_SKILLS", True),
    enable_web_search=settings.WEB_SEARCH_ENABLED,
    enable_checkpointing=getattr(settings, "ENABLE_CHECKPOINTING", False),
)
