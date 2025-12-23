# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell direct chat service (Refactored Version)."""

import asyncio
import json
import logging
import time
from typing import Any, AsyncGenerator

from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.services.chat.base import ChatServiceBase, get_http_client
from app.services.chat.db_handler import db_handler
from app.services.chat.message_builder import message_builder
from app.services.chat.providers import get_provider
from app.services.chat.providers.base import ChunkType, StreamChunk
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
        is_group_chat: bool = False,
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
            is_group_chat: Whether this is a group chat (uses special history truncation)

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
                if is_group_chat:
                    # For group chat, get history from database with user names
                    logger.info(
                        f"[CHAT_STREAM] Getting group chat history for task_id={task_id}, "
                        f"subtask_id={subtask_id}, is_group_chat={is_group_chat}"
                    )
                    history = await self._get_group_chat_history(task_id)
                    logger.info(
                        f"[CHAT_STREAM] Got history: count={len(history)}, "
                        f"roles={[m.get('role') for m in history]}"
                    )
                    # Apply truncation: first N + last M messages
                    history = self._truncate_group_chat_history(history, task_id)
                    logger.info(f"[CHAT_STREAM] After truncation: count={len(history)}")
                else:
                    # For regular chat, get history from Redis
                    history = await session_manager.get_chat_history(task_id)

                messages = message_builder.build_messages(
                    history, message, system_prompt
                )
                logger.info(
                    f"[CHAT_STREAM] Built messages: total={len(messages)}, "
                    f"roles={[m.get('role') for m in messages]}, "
                    f"current_message_preview={str(message)[:100]}..."
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
    ) -> AsyncGenerator[StreamChunk, None]:
        """
        Handle tool calling flow with request count and time limiting.

        The flow suppresses all intermediate content and only outputs the final
        response after tool execution is complete. The model is asked to summarize
        the tool results in the final step.

        Args:
            provider: LLM provider instance
            messages: Conversation messages
            tool_handler: Tool handler instance
            cancel_event: Cancellation event

        Yields:
            StreamChunk objects for the final response only
        """
        # Use settings
        max_requests = settings.CHAT_TOOL_MAX_REQUESTS
        max_time_seconds = settings.CHAT_TOOL_MAX_TIME_SECONDS

        tools = tool_handler.format_for_provider(provider.provider_name)
        start_time = time.monotonic()
        request_count = 0
        all_tool_results: list[dict[str, Any]] = []

        # Extract original question content for summary request
        original_question = messages[-1]

        while request_count < max_requests:
            # Check time limit
            elapsed = time.monotonic() - start_time
            if elapsed >= max_time_seconds:
                logger.warning(
                    "Tool calling flow exceeded time limit: %.1fs >= %.1fs",
                    elapsed,
                    max_time_seconds,
                )
                break

            # Check cancellation
            if cancel_event.is_set():
                return

            request_count += 1
            logger.debug(
                "Tool calling request %d/%d, elapsed %.1fs/%.1fs",
                request_count,
                max_requests,
                elapsed,
                max_time_seconds,
            )
            accumulator = ToolCallAccumulator()

            async for chunk in provider.stream_chat(
                messages, cancel_event, tools=tools
            ):
                if chunk.type == ChunkType.TOOL_CALL and chunk.tool_call:
                    # Pass thought_signature for Gemini 3 Pro function calling support
                    accumulator.add_chunk(chunk.tool_call, chunk.thought_signature)

            # No tool calls - exit loop to generate final response
            if not accumulator.has_calls():
                break

            # Execute tool calls (suppress intermediate content)
            tool_calls = accumulator.get_calls()
            # Add assistant message with tool calls
            messages.append(ToolHandler.build_assistant_message(None, tool_calls))
            # Execute tools and collect results
            tool_results = await tool_handler.execute_all(tool_calls)
            messages.extend(tool_results)
            all_tool_results.extend(tool_results)

            logger.info(
                "Executed %d tool calls in step %d",
                len(tool_calls),
                request_count,
            )

        logger.info(
            "Tool calling flow completed (requests=%d, time=%.1fs, tool_calls=%d), "
            "generating final response",
            request_count,
            time.monotonic() - start_time,
            len(all_tool_results),
        )

        # If tool execution occurred, add summary request
        if all_tool_results:
            summary_request = (
                "Based on the tool execution results above, directly answer my "
                "original question in the same locale as the question. "
            )
            messages.append({"role": "user", "content": summary_request})
            messages.append(original_question)
        # Final request without tools to get the response
        async for chunk in provider.stream_chat(messages, cancel_event, tools=None):
            yield chunk

    async def _get_group_chat_history(self, task_id: int) -> list[dict[str, Any]]:
        """
        Get chat history for group chat mode from database.

        In group chat mode, we need to include user names in the messages
        so the AI can distinguish between different users.

        User messages are formatted as: "User[username]: message content"
        The "User" prefix indicates that the content in brackets is a username.
        Assistant messages remain unchanged.

        For messages with attachments:
        - Image attachments are included as vision content (base64 encoded)
        - Document attachments have their extracted text prepended to the message

        Args:
            task_id: Task ID

        Returns:
            List of message dictionaries with role and content
            Content can be a string or a list (for vision messages)
        """
        return await asyncio.to_thread(self._get_group_chat_history_sync, task_id)

    def _get_group_chat_history_sync(self, task_id: int) -> list[dict[str, Any]]:
        """Synchronous implementation of group chat history retrieval."""
        from app.models.subtask import Subtask, SubtaskStatus
        from app.models.user import User
        from app.services.attachment import attachment_service
        from app.services.chat.db_handler import _db_session

        history: list[dict[str, Any]] = []
        with _db_session() as db:
            # Query all subtasks for this task (for debugging)
            all_subtasks = (
                db.query(Subtask)
                .filter(Subtask.task_id == task_id)
                .order_by(Subtask.message_id.asc())
                .all()
            )
            logger.info(
                f"[GROUP_CHAT_HISTORY] task_id={task_id}, "
                f"total_subtasks={len(all_subtasks)}, "
                f"subtask_details=[{', '.join([f'(id={s.id}, role={s.role.value}, status={s.status.value}, msg_id={s.message_id})' for s in all_subtasks])}]"
            )

            subtasks = (
                db.query(Subtask, User.user_name)
                .outerjoin(User, Subtask.sender_user_id == User.id)
                .filter(
                    Subtask.task_id == task_id,
                    Subtask.status == SubtaskStatus.COMPLETED,
                )
                .order_by(Subtask.message_id.asc())
                .all()
            )

            # Build completed details string separately to avoid f-string escaping issues
            completed_details = ", ".join(
                [
                    f"(id={s.id}, role={s.role.value}, sender={u or 'N/A'})"
                    for s, u in subtasks
                ]
            )
            logger.info(
                f"[GROUP_CHAT_HISTORY] task_id={task_id}, "
                f"completed_subtasks={len(subtasks)}, "
                f"completed_details=[{completed_details}]"
            )

            for subtask, sender_username in subtasks:
                msg = self._build_history_message(
                    db, subtask, sender_username, attachment_service
                )
                if msg:
                    history.append(msg)
                    logger.debug(
                        f"[GROUP_CHAT_HISTORY] Added message: role={msg.get('role')}, "
                        f"content_preview={str(msg.get('content', ''))[:100]}..."
                    )

        logger.info(
            f"[GROUP_CHAT_HISTORY] task_id={task_id}, "
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
    ) -> dict[str, Any] | None:
        """Build a single history message from a subtask."""
        from app.models.subtask import SubtaskRole

        if subtask.role == SubtaskRole.USER:
            return self._build_user_message(
                db, subtask, sender_username, attachment_service
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
    ) -> dict[str, Any]:
        """Build a user message with optional attachments."""
        from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment

        # Build text content with username prefix
        text_content = subtask.prompt or ""
        if sender_username:
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

    def _truncate_group_chat_history(
        self, history: list[dict[str, str]], task_id: int
    ) -> list[dict[str, str]]:
        """
        Truncate chat history for group chat mode.

        In group chat mode, AI-bot sees:
        - First N messages (for context about the conversation start)
        - Last M messages (for recent context)
        - No duplicate messages

        If total messages < N + M, all messages are kept.

        Args:
            history: Full chat history
            task_id: Task ID for logging

        Returns:
            Truncated history list
        """
        first_count = settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES
        last_count = settings.GROUP_CHAT_HISTORY_LAST_MESSAGES
        total_count = len(history)

        # If total messages <= first + last, keep all messages
        if total_count <= first_count + last_count:
            return history

        # Get first N messages and last M messages
        first_messages = history[:first_count]
        last_messages = history[-last_count:]

        # Combine without duplicates (in case of overlap, which shouldn't happen
        # given the check above, but we handle it for safety)
        truncated_history = first_messages + last_messages

        logger.info(
            f"Group chat mode: truncated history for task {task_id} from {total_count} "
            f"to {len(truncated_history)} messages (first {first_count} + last {last_count})"
        )

        return truncated_history

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
