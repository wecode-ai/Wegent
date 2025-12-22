# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph Chat Service - main service entry point.

This module provides a LangGraph-based chat service with:
- Database-based model resolution
- LangChain/LangGraph framework for agent orchestration
- Tool calling and multi-step reasoning
- MCP integration
- Redis session management
- WebSocket event emission
- Streaming responses with SSE support
"""

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Any

from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind

from .agents.graph_builder import LangGraphAgentBuilder
from .events import event_emitter
from .messages import MessageConverter
from .models import LangChainModelFactory, ModelResolver
from .storage import storage_handler
from .tools import ToolRegistry, WebSearchTool
from .tools.mcp import MCPSessionManager

logger = logging.getLogger(__name__)


# SSE response headers
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
}

# Semaphore for concurrent chat limit (lazy initialized)
_chat_semaphore: asyncio.Semaphore | None = None


def _get_chat_semaphore() -> asyncio.Semaphore:
    """Get or create the chat semaphore for concurrency limiting."""
    global _chat_semaphore
    if _chat_semaphore is None:
        _chat_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CHATS)
    return _chat_semaphore


def _sse_data(data: dict) -> str:
    """Format data as SSE event."""
    return f"data: {json.dumps(data)}\n\n"


def extract_usage_from_response(response: Any) -> dict[str, int]:
    """Extract token usage from LangChain response.

    Args:
        response: LangChain response object or message

    Returns:
        Dict with prompt_tokens, completion_tokens, total_tokens
    """
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    # Check for usage_metadata (LangChain >= 0.1.0)
    if hasattr(response, "usage_metadata") and response.usage_metadata:
        metadata = response.usage_metadata
        usage["prompt_tokens"] = getattr(metadata, "input_tokens", 0)
        usage["completion_tokens"] = getattr(metadata, "output_tokens", 0)
        usage["total_tokens"] = getattr(metadata, "total_tokens", 0)
        return usage

    # Check for response_metadata (older LangChain or provider-specific)
    if hasattr(response, "response_metadata") and response.response_metadata:
        metadata = response.response_metadata
        # OpenAI format
        if "token_usage" in metadata:
            token_usage = metadata["token_usage"]
            usage["prompt_tokens"] = token_usage.get("prompt_tokens", 0)
            usage["completion_tokens"] = token_usage.get("completion_tokens", 0)
            usage["total_tokens"] = token_usage.get("total_tokens", 0)
            return usage
        # Anthropic format
        if "usage" in metadata:
            anthropic_usage = metadata["usage"]
            usage["prompt_tokens"] = anthropic_usage.get("input_tokens", 0)
            usage["completion_tokens"] = anthropic_usage.get("output_tokens", 0)
            usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
            return usage

    return usage


class StreamChunk:
    """Stream chunk response."""

    def __init__(
        self,
        delta: dict[str, Any],
        finish_reason: str | None = None,
        usage: dict[str, int] | None = None,
    ):
        self.delta = delta
        self.finish_reason = finish_reason
        self.usage = usage


class CompletionResponse:
    """Chat completion response."""

    def __init__(
        self,
        content: str,
        tool_calls: list[dict[str, Any]] | None = None,
        finish_reason: str = "stop",
        usage: dict[str, int] | None = None,
    ):
        self.content = content
        self.tool_calls = tool_calls
        self.finish_reason = finish_reason
        self.usage = usage or {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }


class LangGraphChatService:
    """Main service for LangGraph-based chat completions.

    Uses LangChain/LangGraph framework for agent orchestration with:
    - Database-based model resolution
    - Real LangGraph state management
    - Tool binding via LangChain
    - OpenAI/Google/Anthropic SDK integration through LangChain
    - Multi-step reasoning with tool loops
    - MCP integration
    - Skills for large file handling
    - SSE streaming responses
    - Redis session management
    - WebSocket event emission
    """

    def __init__(
        self,
        workspace_root: str = "/workspace",
        enable_mcp: bool = False,
        enable_skills: bool = True,
        enable_web_search: bool = False,
        enable_checkpointing: bool = False,
    ):
        """Initialize LangGraph Chat Service.

        Args:
            workspace_root: Root directory for file operations
            enable_mcp: Enable MCP tool integration
            enable_skills: Enable built-in skills
            enable_web_search: Enable web search tool
            enable_checkpointing: Enable state checkpointing for resumability
        """
        self.workspace_root = workspace_root
        self.tool_registry = ToolRegistry()
        self.enable_checkpointing = enable_checkpointing

        # Initialize MCP if enabled
        self.mcp_manager: MCPSessionManager | None = None
        if enable_mcp and settings.CHAT_MCP_ENABLED:
            mcp_config = self._get_mcp_servers_config()
            if mcp_config:
                self.mcp_manager = MCPSessionManager(mcp_config)

        # Initialize Skills if enabled
        if enable_skills:
            from .tools.builtin import FileListSkill, FileReaderSkill

            self.tool_registry.register(FileReaderSkill(workspace_root=workspace_root))
            self.tool_registry.register(FileListSkill(workspace_root=workspace_root))

        # Initialize web search if enabled
        if enable_web_search and settings.WEB_SEARCH_ENABLED:
            self.tool_registry.register(WebSearchTool())

    def _get_mcp_servers_config(self) -> dict[str, Any]:
        """Parse MCP servers configuration from settings."""
        try:
            return json.loads(settings.CHAT_MCP_SERVERS)
        except json.JSONDecodeError as e:
            logger.error(
                "Failed to parse CHAT_MCP_SERVERS JSON: %s. Raw: %s",
                str(e),
                settings.CHAT_MCP_SERVERS,
            )
            return {}

    async def initialize(self) -> None:
        """Initialize async components (MCP connections)."""
        if self.mcp_manager:
            try:
                await self.mcp_manager.connect_all()
                # Register MCP tools
                for tool in self.mcp_manager.get_tools():
                    self.tool_registry.register(tool)
            except Exception as e:
                logger.exception(
                    "Failed to initialize MCP manager: %s. Continuing without MCP.",
                    str(e),
                )
                self.mcp_manager = None

    async def shutdown(self) -> None:
        """Shutdown service and cleanup resources."""
        if self.mcp_manager:
            try:
                await self.mcp_manager.disconnect_all()
            except Exception as e:
                logger.exception("Error during MCP manager shutdown: %s", str(e))

    # ==================== Full Chat Stream (SSE) ====================

    async def chat_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        tools: list[Any] | None = None,
        subtask_id: int | None = None,
        task_id: int | None = None,
        is_group_chat: bool = False,
    ) -> StreamingResponse:
        """
        Stream chat response with full session management.

        This method provides feature parity with the original chat service:
        - Database status updates
        - Redis session management
        - Streaming content cache
        - Cancellation support
        - Group chat history handling

        Args:
            message: User message (string or dict with content)
            model_config: Model configuration dict from ModelResolver
            system_prompt: System prompt for the conversation
            tools: Optional list of additional tools
            subtask_id: Subtask ID (None for simple mode)
            task_id: Task ID (None for simple mode)
            is_group_chat: Whether this is a group chat

        Returns:
            StreamingResponse with SSE events
        """
        # Simple mode: no database operations, no session management
        is_simple_mode = subtask_id is None or task_id is None

        if is_simple_mode:
            return await self._simple_stream(message, model_config, system_prompt)

        # Full mode: with database operations and session management
        return await self._full_stream(
            message=message,
            model_config=model_config,
            system_prompt=system_prompt,
            tools=tools,
            subtask_id=subtask_id,
            task_id=task_id,
            is_group_chat=is_group_chat,
        )

    async def _simple_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
    ) -> StreamingResponse:
        """
        Simple streaming without database operations.

        Lightweight streaming for scenarios like wizard testing.
        """

        async def generate() -> AsyncGenerator[str, None]:
            try:
                # Build messages
                messages = MessageConverter.build_messages(
                    history=[],
                    current_message=message,
                    system_prompt=system_prompt,
                )

                # Create LangChain model
                lc_model = LangChainModelFactory.create_from_config(model_config)

                # Convert to LangChain messages and stream
                lc_messages = MessageConverter.dict_to_langchain(messages)

                async for chunk in lc_model.astream(lc_messages):
                    if chunk.content:
                        yield _sse_data({"content": chunk.content, "done": False})

                yield _sse_data({"content": "", "done": True})

            except Exception as e:
                logger.error(f"Simple stream error: {e}")
                yield _sse_data({"error": str(e)})

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    async def _full_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        tools: list[Any] | None,
        subtask_id: int,
        task_id: int,
        is_group_chat: bool,
    ) -> StreamingResponse:
        """Full streaming with database and session management."""
        semaphore = _get_chat_semaphore()

        async def generate() -> AsyncGenerator[str, None]:
            acquired = False
            cancel_event = await storage_handler.register_stream(subtask_id)

            try:
                # Acquire semaphore with timeout
                try:
                    acquired = await asyncio.wait_for(semaphore.acquire(), timeout=5.0)
                except asyncio.TimeoutError:
                    yield _sse_data({"error": "Too many concurrent chat requests"})
                    await storage_handler.update_subtask_status(
                        subtask_id, "FAILED", error="Too many concurrent chat requests"
                    )
                    return

                await storage_handler.update_subtask_status(subtask_id, "RUNNING")

                # Get chat history
                if is_group_chat:
                    history = await self._get_group_chat_history(task_id)
                    history = self._truncate_group_chat_history(history, task_id)
                else:
                    history = await storage_handler.get_chat_history(task_id)

                # Build messages
                messages = MessageConverter.build_messages(
                    history, message, system_prompt
                )

                # Create LangChain model
                lc_model = LangChainModelFactory.create_from_config(model_config)

                # Prepare tools
                all_tools = list(self.tool_registry.get_all())
                if tools:
                    all_tools.extend(tools)

                # Build agent or use direct LLM
                has_tools = len(all_tools) > 0

                # Stream response
                full_response = ""
                offset = 0
                last_redis_save = asyncio.get_event_loop().time()
                last_db_save = asyncio.get_event_loop().time()

                if has_tools:
                    # Use tool calling flow
                    async for content_chunk in self._handle_tool_calling_flow(
                        lc_model, messages, all_tools, cancel_event
                    ):
                        if cancel_event.is_set():
                            yield _sse_data({"content": "", "done": True, "cancelled": True})
                            return

                        full_response += content_chunk
                        yield _sse_data({"content": content_chunk, "done": False})
                        offset += len(content_chunk)

                        # Periodic saves
                        current_time = asyncio.get_event_loop().time()
                        if current_time - last_redis_save >= settings.STREAMING_REDIS_SAVE_INTERVAL:
                            await storage_handler.save_streaming_content(subtask_id, full_response)
                            last_redis_save = current_time
                        if current_time - last_db_save >= settings.STREAMING_DB_SAVE_INTERVAL:
                            await storage_handler.save_partial_response(subtask_id, full_response)
                            last_db_save = current_time
                else:
                    # Direct LLM streaming
                    lc_messages = MessageConverter.dict_to_langchain(messages)
                    async for chunk in lc_model.astream(lc_messages):
                        if cancel_event.is_set():
                            yield _sse_data({"content": "", "done": True, "cancelled": True})
                            return

                        if chunk.content:
                            full_response += chunk.content
                            yield _sse_data({"content": chunk.content, "done": False})
                            offset += len(chunk.content)

                            # Periodic saves
                            current_time = asyncio.get_event_loop().time()
                            if current_time - last_redis_save >= settings.STREAMING_REDIS_SAVE_INTERVAL:
                                await storage_handler.save_streaming_content(subtask_id, full_response)
                                last_redis_save = current_time
                            if current_time - last_db_save >= settings.STREAMING_DB_SAVE_INTERVAL:
                                await storage_handler.save_partial_response(subtask_id, full_response)
                                last_db_save = current_time

                # Completed
                result = {"value": full_response}
                await storage_handler.save_streaming_content(subtask_id, full_response)
                await storage_handler.publish_streaming_done(subtask_id, result)
                await storage_handler.append_messages(task_id, message, full_response)
                await storage_handler.update_subtask_status(
                    subtask_id, "COMPLETED", result=result
                )

                yield _sse_data({"content": "", "done": True, "result": result})

            except Exception as e:
                logger.exception(f"[STREAM] subtask={subtask_id} error: {e}")
                await storage_handler.update_subtask_status(
                    subtask_id, "FAILED", error=str(e)
                )
                yield _sse_data({"error": str(e)})

            finally:
                await storage_handler.unregister_stream(subtask_id)
                await storage_handler.delete_streaming_content(subtask_id)
                if acquired:
                    semaphore.release()

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    async def _handle_tool_calling_flow(
        self,
        lc_model,
        messages: list[dict[str, Any]],
        tools: list[Any],
        cancel_event: asyncio.Event,
    ) -> AsyncGenerator[str, None]:
        """
        Handle tool calling flow with request count and time limiting.

        Args:
            lc_model: LangChain model instance
            messages: Conversation messages
            tools: List of tools
            cancel_event: Cancellation event

        Yields:
            Content chunks from the final response
        """
        max_requests = settings.CHAT_TOOL_MAX_REQUESTS
        max_time_seconds = settings.CHAT_TOOL_MAX_TIME_SECONDS

        # Bind tools to model
        llm_with_tools = lc_model.bind_tools(tools)

        # Convert messages
        lc_messages = MessageConverter.dict_to_langchain(messages)

        start_time = time.monotonic()
        request_count = 0

        while request_count < max_requests:
            # Check time limit
            elapsed = time.monotonic() - start_time
            if elapsed >= max_time_seconds:
                logger.warning(
                    "Tool calling flow exceeded time limit: %.1fs >= %.1fs",
                    elapsed, max_time_seconds
                )
                break

            if cancel_event.is_set():
                return

            request_count += 1

            # Get response from model
            response = await llm_with_tools.ainvoke(lc_messages)

            # Check for tool calls
            if not hasattr(response, "tool_calls") or not response.tool_calls:
                # No more tool calls, stream final content
                if response.content:
                    yield response.content
                return

            # Execute tool calls
            lc_messages.append(response)
            for tool_call in response.tool_calls:
                tool_name = tool_call["name"]
                tool_args = tool_call["args"]
                tool_id = tool_call.get("id", f"call-{uuid.uuid4()}")

                try:
                    result = await self.tool_registry.invoke_tool(tool_name, **tool_args)
                    result_str = json.dumps(result) if not isinstance(result, str) else result
                except Exception as e:
                    result_str = f"Error: {str(e)}"

                from langchain_core.messages import ToolMessage
                lc_messages.append(ToolMessage(
                    content=result_str,
                    tool_call_id=tool_id,
                    name=tool_name,
                ))

        # After tool loop, get final response without tools
        final_response = await lc_model.ainvoke(lc_messages)
        if final_response.content:
            yield final_response.content

    async def _get_group_chat_history(self, task_id: int) -> list[dict[str, Any]]:
        """Get chat history for group chat mode from database."""
        # Reuse the implementation from the original chat service
        from app.services.chat.chat_service import chat_service
        return await chat_service._get_group_chat_history(task_id)

    def _truncate_group_chat_history(
        self, history: list[dict[str, str]], task_id: int
    ) -> list[dict[str, str]]:
        """Truncate chat history for group chat mode."""
        first_count = settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES
        last_count = settings.GROUP_CHAT_HISTORY_LAST_MESSAGES
        total_count = len(history)

        if total_count <= first_count + last_count:
            return history

        first_messages = history[:first_count]
        last_messages = history[-last_count:]
        truncated_history = first_messages + last_messages

        logger.info(
            f"Group chat: truncated history for task {task_id} from {total_count} "
            f"to {len(truncated_history)} messages"
        )

        return truncated_history

    # ==================== Completion API ====================

    async def chat_completion(
        self,
        model_config: dict[str, Any],
        messages: list[dict[str, Any]],
        stream: bool = False,
        tools: list[dict[str, Any]] | None = None,
        deep_thinking: bool = False,
        max_tool_iterations: int = 10,
        thread_id: str | None = None,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute chat completion with LangGraph agent.

        Args:
            model_config: Model configuration from ModelResolver
            messages: Conversation messages
            stream: Whether to stream response
            tools: Optional custom tools
            deep_thinking: Enable multi-step reasoning with tool loops
            max_tool_iterations: Maximum tool call iterations
            thread_id: Thread ID for checkpointing
            **kwargs: Additional parameters (temperature, max_tokens, etc.)

        Returns:
            CompletionResponse or AsyncIterator[StreamChunk]
        """
        try:
            # Create LangChain model instance from config
            lc_model = LangChainModelFactory.create_from_config(model_config, **kwargs)
        except Exception as e:
            logger.exception("Failed to create model: %s", str(e))
            raise ValueError(f"Failed to create model: {str(e)}") from e

        try:
            # Build LangGraph agent
            agent_builder = LangGraphAgentBuilder(
                llm=lc_model,
                tool_registry=self.tool_registry,
                max_iterations=max_tool_iterations,
                enable_checkpointing=self.enable_checkpointing,
            )
        except Exception as e:
            logger.exception("Failed to build LangGraph agent: %s", str(e))
            raise ValueError(f"Failed to build agent: {str(e)}") from e

        # Prepare config
        config_dict = {"thread_id": thread_id or f"thread-{uuid.uuid4()}"}

        # Decide whether to use agent or direct LLM
        has_tools = len(self.tool_registry.get_all()) > 0

        if deep_thinking or has_tools:
            if stream:
                return self._stream_agent_execution(agent_builder, messages, config_dict)
            else:
                return await self._execute_agent(agent_builder, messages, config_dict)
        else:
            if stream:
                return self._stream_direct_llm(lc_model, messages)
            else:
                return await self._execute_direct_llm(lc_model, messages)

    async def _execute_agent(
        self,
        agent_builder: LangGraphAgentBuilder,
        messages: list[dict[str, Any]],
        config: dict[str, Any],
    ) -> CompletionResponse:
        """Execute LangGraph agent workflow."""
        final_state = await agent_builder.execute(messages, config)
        final_messages = final_state["messages"]
        last_message = final_messages[-1]

        usage = extract_usage_from_response(last_message)
        if usage["total_tokens"] == 0:
            for msg in final_messages:
                if isinstance(msg, AIMessage):
                    msg_usage = extract_usage_from_response(msg)
                    if msg_usage["total_tokens"] > 0:
                        usage["prompt_tokens"] += msg_usage["prompt_tokens"]
                        usage["completion_tokens"] += msg_usage["completion_tokens"]
                        usage["total_tokens"] += msg_usage["total_tokens"]

        if isinstance(last_message, AIMessage):
            content = last_message.content if isinstance(last_message.content, str) else ""
            tool_calls = None

            if hasattr(last_message, "tool_calls") and last_message.tool_calls:
                tool_calls = [
                    {
                        "id": tc.get("id", f"call-{uuid.uuid4()}"),
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": json.dumps(tc["args"]),
                        },
                    }
                    for tc in last_message.tool_calls
                ]

            return CompletionResponse(
                content=content,
                tool_calls=tool_calls,
                finish_reason="stop",
                usage=usage,
            )
        else:
            return CompletionResponse(
                content=str(last_message.content) if hasattr(last_message, "content") else "",
                tool_calls=None,
                finish_reason="stop",
                usage=usage,
            )

    async def _stream_agent_execution(
        self,
        agent_builder: LangGraphAgentBuilder,
        messages: list[dict[str, Any]],
        config: dict[str, Any],
    ) -> AsyncIterator[StreamChunk]:
        """Stream LangGraph agent execution."""
        accumulated_usage = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }

        async for event in agent_builder.stream_execute(messages, config):
            for node_name, state in event.items():
                if "messages" in state:
                    for msg in state["messages"]:
                        if isinstance(msg, AIMessage):
                            if msg.content:
                                yield StreamChunk(
                                    delta={"content": msg.content}, finish_reason=None
                                )

                            if hasattr(msg, "tool_calls") and msg.tool_calls:
                                tool_calls_formatted = [
                                    {
                                        "id": tc.get("id", f"call-{uuid.uuid4()}"),
                                        "type": "function",
                                        "function": {
                                            "name": tc["name"],
                                            "arguments": json.dumps(tc["args"]),
                                        },
                                    }
                                    for tc in msg.tool_calls
                                ]
                                yield StreamChunk(
                                    delta={"tool_calls": tool_calls_formatted},
                                    finish_reason=None,
                                )

                            msg_usage = extract_usage_from_response(msg)
                            if msg_usage["total_tokens"] > 0:
                                accumulated_usage["prompt_tokens"] += msg_usage["prompt_tokens"]
                                accumulated_usage["completion_tokens"] += msg_usage["completion_tokens"]
                                accumulated_usage["total_tokens"] += msg_usage["total_tokens"]

        yield StreamChunk(delta={}, finish_reason="stop", usage=accumulated_usage)

    async def _execute_direct_llm(
        self,
        lc_model,
        messages: list[dict[str, Any]],
    ) -> CompletionResponse:
        """Execute direct LLM call without tools."""
        lc_messages = MessageConverter.dict_to_langchain(messages)
        response = await lc_model.ainvoke(lc_messages)
        usage = extract_usage_from_response(response)

        return CompletionResponse(
            content=response.content if isinstance(response.content, str) else "",
            tool_calls=None,
            finish_reason="stop",
            usage=usage,
        )

    async def _stream_direct_llm(
        self,
        lc_model,
        messages: list[dict[str, Any]],
    ) -> AsyncIterator[StreamChunk]:
        """Stream direct LLM call without tools."""
        lc_messages = MessageConverter.dict_to_langchain(messages)
        accumulated_usage = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }

        async for chunk in lc_model.astream(lc_messages):
            if chunk.content:
                yield StreamChunk(delta={"content": chunk.content}, finish_reason=None)

            chunk_usage = extract_usage_from_response(chunk)
            if chunk_usage["total_tokens"] > 0:
                accumulated_usage = chunk_usage

        yield StreamChunk(delta={}, finish_reason="stop", usage=accumulated_usage)

    # ==================== Non-streaming Completion ====================

    async def simple_completion(
        self,
        message: str,
        model_config: dict[str, Any],
        system_prompt: str = "",
    ) -> str:
        """
        Non-streaming chat completion for simple LLM calls.

        Args:
            message: User message
            model_config: Model configuration dict
            system_prompt: System prompt for the conversation

        Returns:
            The LLM response as a string
        """
        messages = MessageConverter.build_messages(
            history=[],
            current_message=message,
            system_prompt=system_prompt,
        )

        lc_model = LangChainModelFactory.create_from_config(model_config)
        lc_messages = MessageConverter.dict_to_langchain(messages)
        response = await lc_model.ainvoke(lc_messages)

        return response.content if isinstance(response.content, str) else ""

    # ==================== Tool Management ====================

    def list_available_tools(self) -> list[dict[str, Any]]:
        """List all available tools in OpenAI format."""
        tools = []
        for tool in self.tool_registry.get_all():
            tools.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.args_schema.schema() if tool.args_schema else {},
                },
            })
        return tools

    def get_tool_registry(self) -> ToolRegistry:
        """Get tool registry instance."""
        return self.tool_registry


# Global service instance (for convenience)
langgraph_chat_service = LangGraphChatService()
