# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell direct chat service (Refactored Version)."""

import asyncio
import json
import logging
from typing import Any, AsyncGenerator

from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.services.chat.base import ChatServiceBase, get_http_client
from app.services.chat.db_handler import db_handler
from app.services.chat.message_builder import message_builder
from app.services.chat.providers import get_provider
from app.services.chat.providers.base import ChunkType, ProviderConfig, StreamChunk
from app.services.chat.session_manager import session_manager
from app.services.chat.stream_manager import StreamState, stream_manager
from app.services.chat.tool_handler import ToolCallAccumulator, ToolHandler
from app.services.chat.tools import Tool, cleanup_mcp_session, get_mcp_session

logger = logging.getLogger(__name__)

# Semaphore for concurrent chat limit (lazy initialized)
_chat_semaphore: asyncio.Semaphore | None = None

# SSE response headers
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
}


def _get_chat_semaphore() -> asyncio.Semaphore:
    """Get or create the chat semaphore for concurrency limiting."""
    global _chat_semaphore
    if _chat_semaphore is None:
        _chat_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CHATS)
    return _chat_semaphore


def _sse_data(data: dict) -> str:
    """Format data as SSE event."""
    return f"data: {json.dumps(data)}\n\n"


class ChatService(ChatServiceBase):
    """Chat Shell direct chat service with modular architecture."""

    async def chat_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        tools: list[Tool] | None = None,
        subtask_id: int | None = None,
        task_id: int | None = None,
    ) -> StreamingResponse:
        """
        Stream chat response from LLM API with tool calling support.

        This method automatically loads MCP tools if CHAT_MCP_ENABLED is True
        and CHAT_MCP_SERVERS is configured. MCP sessions are managed per-task
        and cleaned up when the stream ends.

        When subtask_id and task_id are None, this method operates in "simple mode"
        without database operations, session management, or MCP tools. This is useful
        for lightweight streaming scenarios like wizard testing.

        Args:
            message: User message (string or dict with content)
            model_config: Model configuration dict
            system_prompt: System prompt for the conversation
            tools: Optional list of Tool instances (web search, etc.)
            subtask_id: Optional subtask ID (None for simple mode)
            task_id: Optional task ID (None for simple mode)

        Returns:
            StreamingResponse with SSE events
        """
        # Simple mode: no database operations, no session management
        is_simple_mode = subtask_id is None or task_id is None

        if is_simple_mode:
            return await self._simple_stream(message, model_config, system_prompt)

        # Full mode: with database operations and session management
        semaphore = _get_chat_semaphore()
        chunk_queue: asyncio.Queue = asyncio.Queue()
        mcp_session = None

        async def generate() -> AsyncGenerator[str, None]:
            nonlocal mcp_session
            acquired = False
            consumer_task = None
            cancel_event = await session_manager.register_stream(subtask_id)

            try:
                # Acquire semaphore with timeout
                try:
                    acquired = await asyncio.wait_for(semaphore.acquire(), timeout=5.0)
                except asyncio.TimeoutError:
                    yield _sse_data({"error": "Too many concurrent chat requests"})
                    await db_handler.update_subtask_status(
                        subtask_id, "FAILED", error="Too many concurrent chat requests"
                    )
                    return

                await db_handler.update_subtask_status(subtask_id, "RUNNING")

                # Build messages and initialize components
                history = await session_manager.get_chat_history(task_id)
                messages = message_builder.build_messages(
                    history, message, system_prompt
                )

                # Prepare all tools (passed tools + MCP tools)
                all_tools: list[Tool] = list(tools) if tools else []

                # Load MCP tools if enabled
                mcp_session = await get_mcp_session(task_id)
                if mcp_session:
                    all_tools.extend(mcp_session.get_tools())

                # Initialize tool handler if we have any tools
                tool_handler = ToolHandler(all_tools) if all_tools else None
                client = await get_http_client()
                provider = get_provider(model_config, client)

                # Create stream generator
                stream_gen = (
                    self._handle_tool_calling_flow(
                        provider, messages, tool_handler, cancel_event
                    )
                    if tool_handler and tool_handler.has_tools
                    else provider.stream_chat(messages, cancel_event, tools=None)
                )

                # Start background consumer
                state = StreamState(
                    subtask_id=subtask_id, task_id=task_id, user_message=message
                )
                consumer_task = await stream_manager.create_consumer_task(
                    state, stream_gen, cancel_event, chunk_queue
                )

                # Yield chunks to client
                async for sse_event in self._process_queue(chunk_queue, consumer_task):
                    yield sse_event

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("[STREAM] subtask=%s error", subtask_id)
            finally:
                if not consumer_task:
                    await session_manager.unregister_stream(subtask_id)
                if acquired:
                    semaphore.release()
                # Cleanup MCP session when stream ends
                if mcp_session:
                    await cleanup_mcp_session(task_id)

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    async def _simple_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
    ) -> StreamingResponse:
        """
        Simple streaming without database operations.

        This is a lightweight streaming method for scenarios like wizard testing
        where we don't need to persist messages or manage complex state.
        """

        async def generate() -> AsyncGenerator[str, None]:
            cancel_event = asyncio.Event()

            try:
                # Build messages
                messages = message_builder.build_messages(
                    history=[],
                    current_message=message,
                    system_prompt=system_prompt,
                )

                # Get provider
                client = await get_http_client()
                provider = get_provider(model_config, client)
                if not provider:
                    yield _sse_data(
                        {"error": "Failed to create provider from model config"}
                    )
                    return

                # Stream response
                async for chunk in provider.stream_chat(messages, cancel_event):
                    if chunk.type == ChunkType.CONTENT and chunk.content:
                        yield _sse_data({"content": chunk.content, "done": False})
                    elif chunk.type == ChunkType.ERROR:
                        yield _sse_data(
                            {"error": chunk.error or "Unknown error from LLM"}
                        )
                        return

                # Send done signal
                yield _sse_data({"content": "", "done": True})

            except Exception as e:
                logger.error(f"Simple stream error: {e}")
                yield _sse_data({"error": str(e)})

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    async def _process_queue(
        self, chunk_queue: asyncio.Queue, consumer_task: asyncio.Task
    ) -> AsyncGenerator[str, None]:
        """Process queue items and yield SSE events."""
        while True:
            try:
                item = await asyncio.wait_for(chunk_queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                if consumer_task.done():
                    break
                continue

            item_type = item["type"]
            if item_type == "chunk":
                yield _sse_data({"content": item["content"], "done": False})
            elif item_type == "done":
                yield _sse_data(
                    {"content": "", "done": True, "result": item.get("result")}
                )
                break
            elif item_type == "cancelled":
                yield _sse_data({"content": "", "done": True, "cancelled": True})
                break
            elif item_type == "error":
                yield _sse_data({"error": item["message"]})
                break
            elif item_type == "end":
                break

    async def _handle_tool_calling_flow(
        self,
        provider,
        messages: list[dict[str, Any]],
        tool_handler: ToolHandler,
        cancel_event: asyncio.Event,
        max_depth: int = 5,
    ) -> AsyncGenerator[StreamChunk, None]:
        """Handle tool calling flow with recursion depth limiting."""
        tools = tool_handler.format_for_provider(provider.provider_name)

        for current_depth in range(max_depth):
            is_final_step = current_depth >= max_depth - 1

            # Final step - stream directly
            if is_final_step:
                async for chunk in provider.stream_chat(
                    messages, cancel_event, tools=None
                ):
                    if chunk.type in (ChunkType.CONTENT, ChunkType.ERROR) and (
                        chunk.content or chunk.error
                    ):
                        yield chunk
                return

            # Intermediate step - accumulate and check for tool calls
            accumulated_content, content_chunks, accumulator = (
                "",
                [],
                ToolCallAccumulator(),
            )

            async for chunk in provider.stream_chat(
                messages, cancel_event, tools=tools
            ):
                if chunk.type == ChunkType.CONTENT and chunk.content:
                    accumulated_content += chunk.content
                    content_chunks.append(chunk)
                elif chunk.type == ChunkType.TOOL_CALL and chunk.tool_call:
                    accumulator.add_chunk(chunk.tool_call)
                elif chunk.type == ChunkType.ERROR:
                    yield chunk
                    return

            # No tool calls - yield accumulated content
            if not accumulator.has_calls():
                for chunk in content_chunks:
                    yield chunk
                return

            # Execute tool calls
            tool_calls = accumulator.get_calls()
            if accumulated_content:
                logger.debug(
                    "Tool calling step %s: suppressing %s chars",
                    current_depth,
                    len(accumulated_content),
                )

            messages.append(
                ToolHandler.build_assistant_message(accumulated_content, tool_calls)
            )
            messages.extend(await tool_handler.execute_all(tool_calls))

    async def chat_completion(
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
        # Build messages
        messages = message_builder.build_messages(
            history=[],
            current_message=message,
            system_prompt=system_prompt,
        )

        # Get provider
        client = await get_http_client()
        provider = get_provider(model_config, client)
        if not provider:
            raise ValueError("Failed to create provider from model config")

        # Collect all content from streaming response
        cancel_event = asyncio.Event()
        accumulated_content = ""

        try:
            async for chunk in provider.stream_chat(messages, cancel_event):
                if chunk.type == ChunkType.CONTENT and chunk.content:
                    accumulated_content += chunk.content
                elif chunk.type == ChunkType.ERROR:
                    raise ValueError(chunk.error or "Unknown error from LLM")
        except Exception as e:
            logger.error(f"Chat completion error: {e}")
            raise

        return accumulated_content


# Global chat service instance
chat_service = ChatService()
