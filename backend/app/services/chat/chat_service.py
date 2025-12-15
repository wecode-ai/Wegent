# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell direct chat service.

Provides streaming chat functionality by directly calling LLM APIs
(OpenAI, Claude) without going through the Docker Executor.
"""

import asyncio
import inspect
import json
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

import httpx
from fastapi.responses import StreamingResponse
from fastmcp import FastMCP
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.services.chat.base import ChatServiceBase, get_http_client
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)

# Thread pool for database operations
_db_executor = ThreadPoolExecutor(max_workers=10)

# Semaphore for concurrent chat limit
_chat_semaphore: Optional[asyncio.Semaphore] = None

# Registry for background consumer tasks (keyed by subtask_id)
# This allows consumer tasks to continue running even after client disconnects
_background_consumer_tasks: Dict[int, asyncio.Task] = {}


def _get_chat_semaphore() -> asyncio.Semaphore:
    """Get or create the chat semaphore for concurrency limiting."""
    global _chat_semaphore
    if _chat_semaphore is None:
        _chat_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CHATS)
    return _chat_semaphore


class ChatService(ChatServiceBase):
    """
    Chat Shell direct chat service.

    Handles streaming chat by directly calling LLM APIs.
    """

    async def chat_stream(
        self,
        subtask_id: int,
        task_id: int,
        message: Union[str, Dict[str, Any]],
        model_config: Dict[str, Any],
        system_prompt: str = "",
        tools: Optional[List[FastMCP]] = None,
    ) -> StreamingResponse:
        """
        Stream chat response from LLM API with tool calling support.

        Args:
            subtask_id: Subtask ID for status updates
            task_id: Task ID for session history
            message: User message (string or vision dict)
            model_config: Model configuration (api_key, base_url, model_id, model)
            system_prompt: Bot's system prompt
            tools: Optional list of tool definitions

        Returns:
            StreamingResponse with SSE events
        """
        semaphore = _get_chat_semaphore()

        # Use a queue to decouple LLM streaming from client output
        # This ensures data is saved to Redis/DB even if client (nginx) stops reading
        chunk_queue: asyncio.Queue = asyncio.Queue()

        # These will be set by generate() before starting consumer task
        cancel_event: Optional[asyncio.Event] = None
        messages: List[Dict[str, Any]] = []

        async def llm_consumer_task():
            """
            Background task that consumes LLM stream and saves to Redis/DB.
            This runs independently of client connection state.

            CRITICAL: This task continues running even after client disconnects.
            It will complete the LLM stream and save all data to Redis/DB,
            allowing users to resume the stream when they switch back.
            """
            full_response = ""
            cancelled = False
            error_info = None
            chunk_count = 0

            try:
                # Determine which streaming method to use
                if tools:
                    # Tool calling flow
                    stream_generator = self._handle_tool_calling_flow(
                        model_config,
                        messages,
                        tools,
                        subtask_id,
                        task_id,
                        message,
                        cancel_event,
                    )
                else:
                    # Regular streaming
                    stream_generator = self._call_llm_streaming_with_cancel(
                        model_config, messages, subtask_id, cancel_event
                    )

                # Incremental save timing
                last_redis_save = time.time()
                last_db_save = time.time()
                redis_interval = settings.STREAMING_REDIS_SAVE_INTERVAL
                db_interval = settings.STREAMING_DB_SAVE_INTERVAL
                cancelled = False

                async for chunk_data in stream_generator:
                    chunk_count += 1
                    # Check if cancelled (local event or Redis flag)
                    if cancel_event.is_set() or await session_manager.is_cancelled(
                        subtask_id
                    ):
                        cancelled = True
                        break

                    # Extract content from chunk (handle both str and dict)
                    chunk = ""
                    if isinstance(chunk_data, dict):
                        if chunk_data.get("type") == "content":
                            chunk = chunk_data.get("content", "")
                    elif isinstance(chunk_data, str):
                        chunk = chunk_data

                    if not chunk:
                        continue

                    full_response += chunk

                    # CRITICAL: Save to Redis/DB BEFORE putting to queue
                    # This ensures data is persisted even if yield blocks
                    current_time = time.time()

                    # Incremental save to Redis (high frequency)
                    if current_time - last_redis_save >= redis_interval:
                        await session_manager.save_streaming_content(
                            subtask_id, full_response
                        )
                        last_redis_save = current_time

                    # Incremental save to database (low frequency)
                    if current_time - last_db_save >= db_interval:
                        await self._save_partial_response(
                            subtask_id, full_response, is_streaming=True
                        )
                        last_db_save = current_time

                    # Publish chunk to Redis Pub/Sub for real-time updates
                    try:
                        await session_manager.publish_streaming_chunk(subtask_id, chunk)
                    except Exception as pub_err:
                        logger.warning(
                            f"[STREAM] subtask={subtask_id} failed to publish chunk: {pub_err}"
                        )

                    # Put chunk to queue for client output (non-blocking with timeout)
                    try:
                        # Use put_nowait to avoid blocking if queue is full
                        # If queue is full, client is not consuming, but we continue anyway
                        chunk_queue.put_nowait({"type": "chunk", "content": chunk})
                    except asyncio.QueueFull:
                        logger.warning(
                            f"[STREAM] subtask={subtask_id} queue full at chunk {chunk_count}, client may be slow/disconnected"
                        )

                # LLM stream finished - save final state
                if cancelled:
                    logger.info(
                        f"[STREAM] subtask={subtask_id} handling cancellation, putting cancelled signal to queue"
                    )
                    # Put cancelled signal to queue
                    try:
                        chunk_queue.put_nowait({"type": "cancelled"})
                    except asyncio.QueueFull:
                        logger.warning(
                            f"[STREAM] subtask={subtask_id} queue full, cannot put cancelled signal"
                        )
                else:
                    # Normal completion - save everything to DB
                    await session_manager.append_user_and_assistant_messages(
                        task_id, message, full_response
                    )

                    result = {"value": full_response}
                    await self._update_subtask_status_sync(
                        subtask_id, "COMPLETED", result=result
                    )

                    # Clean up Redis streaming cache
                    await session_manager.delete_streaming_content(subtask_id)

                    # Publish stream done signal
                    try:
                        await session_manager.publish_streaming_done(
                            subtask_id, result=result
                        )
                    except Exception as pub_err:
                        logger.warning(
                            f"[STREAM] subtask={subtask_id} failed to publish done signal: {pub_err}"
                        )

                    # Put done signal to queue
                    try:
                        chunk_queue.put_nowait({"type": "done", "result": result})
                    except asyncio.QueueFull:
                        pass  # Data is already saved

            except asyncio.CancelledError:
                # Task was cancelled (e.g., server shutdown)
                if full_response:
                    await session_manager.append_user_and_assistant_messages(
                        task_id, message, full_response
                    )
                    result = {
                        "value": full_response,
                        "incomplete": True,
                        "reason": "server_shutdown",
                    }
                    await self._update_subtask_status(
                        subtask_id, "COMPLETED", result=result
                    )
                    await session_manager.delete_streaming_content(subtask_id)
                raise

            except asyncio.TimeoutError:
                error_info = {"type": "error", "message": "API call timeout"}
                logger.error(f"[STREAM] subtask={subtask_id} API call timeout")
                if full_response:
                    await self._save_partial_response(
                        subtask_id, full_response, is_streaming=False
                    )
                await self._update_subtask_status(
                    subtask_id, "FAILED", error="API call timeout"
                )

            except httpx.RequestError as e:
                error_msg = f"Network error: {str(e)}"
                error_info = {"type": "error", "message": error_msg}
                logger.error(f"[STREAM] subtask={subtask_id} network error: {e}")
                if full_response:
                    await self._save_partial_response(
                        subtask_id, full_response, is_streaming=False
                    )
                await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)

            except Exception as e:
                error_msg = str(e)
                error_info = {"type": "error", "message": error_msg}
                logger.error(f"[STREAM] subtask={subtask_id} error: {e}", exc_info=True)
                if full_response:
                    await self._save_partial_response(
                        subtask_id, full_response, is_streaming=False
                    )
                await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)

            finally:
                # Always put end signal to queue so generator knows to stop
                try:
                    if error_info:
                        chunk_queue.put_nowait(error_info)
                    chunk_queue.put_nowait({"type": "end"})
                except asyncio.QueueFull:
                    pass

                # Clean up from background registry
                _background_consumer_tasks.pop(subtask_id, None)

                # Clean up stream registration (if generate() didn't do it)
                # This is safe to call multiple times
                await session_manager.unregister_stream(subtask_id)

        async def generate() -> AsyncGenerator[str, None]:
            nonlocal cancel_event, messages
            acquired = False
            consumer_task = None

            # Register this stream for cancellation support (async for Redis)
            cancel_event = await session_manager.register_stream(subtask_id)

            try:
                # Try to acquire semaphore with timeout
                try:
                    acquired = await asyncio.wait_for(semaphore.acquire(), timeout=5.0)
                except asyncio.TimeoutError:
                    error_msg = (
                        "Too many concurrent chat requests, please try again later"
                    )
                    logger.warning(
                        f"[STREAM] subtask={subtask_id} too many concurrent requests"
                    )
                    yield f"data: {json.dumps({'error': error_msg})}\n\n"
                    await self._update_subtask_status(
                        subtask_id, "FAILED", error=error_msg
                    )
                    return

                # Update status to RUNNING
                await self._update_subtask_status(subtask_id, "RUNNING")

                # Get chat history
                history = await session_manager.get_chat_history(task_id)

                # Build messages list - need to make this available to consumer task
                messages = self._build_messages(history, message, system_prompt)

                # Start background task to consume LLM stream
                # CRITICAL: Register in global registry so it continues even if client disconnects
                consumer_task = asyncio.create_task(llm_consumer_task())
                _background_consumer_tasks[subtask_id] = consumer_task

                # Read from queue and yield to client
                # If yield blocks (nginx not reading), the consumer task continues independently
                while True:
                    try:
                        # Wait for next item from queue with timeout
                        # Timeout allows us to check if consumer task is still alive
                        item = await asyncio.wait_for(chunk_queue.get(), timeout=30.0)
                    except asyncio.TimeoutError:
                        # Check if consumer task is done
                        if consumer_task.done():
                            # Consumer finished but we didn't get end signal, break
                            break
                        continue

                    if item["type"] == "chunk":
                        yield f"data: {json.dumps({'content': item['content'], 'done': False})}\n\n"
                    elif item["type"] == "done":
                        yield f"data: {json.dumps({'content': '', 'done': True, 'result': item.get('result')})}\n\n"
                        break
                    elif item["type"] == "cancelled":
                        yield f"data: {json.dumps({'content': '', 'done': True, 'cancelled': True})}\n\n"
                        break
                    elif item["type"] == "error":
                        yield f"data: {json.dumps({'error': item['message']})}\n\n"
                        break
                    elif item["type"] == "end":
                        break

            except asyncio.CancelledError:
                # Client disconnected (e.g., user switched to another chat)
                # CRITICAL: Do NOT cancel consumer_task - let it continue running in background
                # This allows the LLM stream to complete and save data to Redis/DB
                # so that when user switches back, they can resume the stream
                # Don't cancel consumer_task - it will continue running and saving data
                # The task is registered in _background_consumer_tasks and will clean itself up
                raise

            except Exception as e:
                logger.error(f"[STREAM] subtask={subtask_id} error: {e}", exc_info=True)
                # Consumer task handles its own errors and saves data

            finally:
                # Only wait for consumer task if it's done or we're not being cancelled
                # If we're being cancelled (client disconnect), let consumer continue in background
                if consumer_task:
                    if consumer_task.done():
                        # Clean up from registry
                        _background_consumer_tasks.pop(subtask_id, None)

                # Cleanup: release semaphore
                # Note: Do NOT unregister stream here if consumer_task is still running
                # The consumer_task needs the cancel_event to remain valid
                # It will clean up when it finishes
                if consumer_task and not consumer_task.done():
                    # Consumer task is still running - don't unregister stream
                    # The consumer task will handle cleanup when it finishes
                    pass
                else:
                    # Consumer task is done, safe to unregister
                    await session_manager.unregister_stream(subtask_id)
                if acquired:
                    semaphore.release()

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # Disable nginx buffering
                "Content-Encoding": "none",  # Ensure no compression buffering
            },
        )

    def _safe_parse_json_args(
        self, args: Union[str, Dict], tool_name: str, tool_id: str = "unknown"
    ) -> Dict[str, Any]:
        """
        Safely parse tool arguments, handling both string JSON and existing dicts.
        Returns empty dict on failure to prevent crashes.
        """
        if isinstance(args, dict):
            return args

        if not isinstance(args, str):
            logger.warning(
                f"Tool arguments for {tool_name} (id={tool_id}) are not string or dict: {type(args)}"
            )
            return {}

        try:
            return json.loads(args)
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning(
                f"Failed to parse JSON arguments for tool '{tool_name}' (id={tool_id}): {e}. "
                f"Raw args: {args[:500]}..."
            )
            return {}

    def _build_messages(
        self,
        history: List[Dict[str, str]],
        current_message: Union[str, Dict[str, Any]],
        system_prompt: str,
    ) -> List[Dict[str, Any]]:
        """
        Build message list for LLM API.

        Args:
            history: Previous conversation history
            current_message: Current user message (string or vision dict)
            system_prompt: System prompt

        Returns:
            List of message dictionaries
        """
        messages = []

        # Add system prompt if provided
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        # Add history messages
        messages.extend(history)

        # Add current message
        if (
            isinstance(current_message, dict)
            and current_message.get("type") == "vision"
        ):
            # Build vision message content using standard OpenAI format
            vision_content = [
                {"type": "text", "text": current_message.get("text", "")},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{current_message['mime_type']};base64,{current_message['image_base64']}"
                    },
                },
            ]
            messages.append({"role": "user", "content": vision_content})
        else:
            # Regular text message
            message_text = (
                current_message
                if isinstance(current_message, str)
                else current_message.get("text", "")
            )
            messages.append({"role": "user", "content": message_text})

        return messages

    async def _handle_tool_calling_flow(
        self,
        model_config: Dict[str, Any],
        messages: List[Dict[str, Any]],
        tools: List[Any],
        subtask_id: int,
        task_id: int,
        original_message: Union[str, Dict[str, Any]],
        cancel_event: asyncio.Event,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Handle tool calling flow: send request with tools, detect tool calls, execute them, send results back.

        IMPORTANT: During tool calling iterations, we do NOT yield intermediate content to the user.
        Only the final response (after all tool calls are complete) is yielded.
        This prevents tool call arguments and intermediate "thinking" from being shown to users.
        """
        # Step 0: Flatten tools (extract from FastMCP)
        flat_tools = await self._flatten_tools(tools)

        # Step 1: Adapt tools for the specific model
        model_type = model_config.get("model", "openai")
        adapted_tools = self._adapt_tools_for_model(flat_tools, model_type)

        # Loop with recursion depth limiting
        max_depth = 5  # Max tool recursion depth
        current_depth = 0

        while current_depth < max_depth:
            # Only send tools if we are not at the max depth
            # This forces the model to generate a final answer on the last step
            current_tools = adapted_tools if current_depth < max_depth - 1 else None

            # Call LLM streaming
            stream_generator = self._call_llm_streaming_with_cancel(
                model_config,
                messages,
                subtask_id,
                cancel_event,
                tools=current_tools,
            )

            # Accumulate tool calls and content for this step
            accumulated_content = ""
            tool_calls_accumulator = {}  # index -> {id, name, arguments}

            async for chunk_data in stream_generator:
                if not isinstance(chunk_data, dict):
                    # Backward compatibility check
                    if chunk_data:
                        # Don't yield yet - we need to check if this step has tool calls
                        accumulated_content += chunk_data
                    continue

                if chunk_data.get("type") == "content":
                    content = chunk_data.get("content", "")
                    if content:
                        accumulated_content += content
                        # Don't yield yet - we need to check if this step has tool calls

                elif chunk_data.get("type") == "tool_call_chunk":
                    tc = chunk_data.get("tool_call", {})
                    idx = tc.get("index", 0)

                    if idx not in tool_calls_accumulator:
                        tool_calls_accumulator[idx] = {
                            "id": "",
                            "name": "",
                            "arguments": "",
                        }

                    if tc.get("id"):
                        tool_calls_accumulator[idx]["id"] = tc["id"]
                    if tc.get("name"):
                        tool_calls_accumulator[idx]["name"] = tc["name"]
                    if tc.get("arguments"):
                        tool_calls_accumulator[idx]["arguments"] += tc["arguments"]

            # Check for tool calls
            if not tool_calls_accumulator:
                # No tool calls detected - this is the final response
                # Now yield the accumulated content to the user
                if accumulated_content:
                    yield {"type": "content", "content": accumulated_content}
                return

            # Tool calls detected - do NOT yield accumulated_content to user
            # The accumulated_content during tool calling often contains:
            # - Tool call arguments (e.g., {"query": "...", "limit": 5})
            # - Intermediate "thinking" that shouldn't be shown
            # We only log it for debugging purposes
            if accumulated_content:
                logger.debug(
                    f"Tool calling step {current_depth}: suppressing intermediate content "
                    f"({len(accumulated_content)} chars) from user output"
                )

            # Reconstruct tool calls
            tool_calls = []
            for idx in sorted(tool_calls_accumulator.keys()):
                tc = tool_calls_accumulator[idx]
                tool_calls.append(
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                )

            # Construct assistant message (include content for context, but don't show to user)
            assistant_message = {
                "role": "assistant",
                "content": accumulated_content if accumulated_content else None,
                "tool_calls": tool_calls,
            }
            messages.append(assistant_message)

            # Execute tool calls
            for tool_call in tool_calls:
                function_name = tool_call["function"]["name"]
                tool_call_id = tool_call["id"]
                function_args = self._safe_parse_json_args(
                    tool_call["function"]["arguments"], function_name, tool_call_id
                )

                logger.info(f"Executing tool call: {function_name}")

                # Execute tool
                tool_result = ""
                found_tool = next(
                    (t for t in flat_tools if getattr(t, "name", "") == function_name),
                    None,
                )

                if found_tool:
                    try:
                        # Get the underlying function
                        fn = getattr(found_tool, "fn", None)
                        if fn:
                            if inspect.iscoroutinefunction(fn):
                                tool_result = await fn(**function_args)
                            else:
                                tool_result = fn(**function_args)
                        elif callable(found_tool):
                            # Fallback if tool itself is callable
                            if inspect.iscoroutinefunction(found_tool):
                                tool_result = await found_tool(**function_args)
                            else:
                                tool_result = found_tool(**function_args)
                        else:
                            tool_result = f"Tool {function_name} execution failed: Tool function not found"

                    except (TypeError, AttributeError, ValueError) as e:
                        logger.exception(f"Tool execution failed for {function_name}")
                        tool_result = f"Error: {str(e)}"
                else:
                    tool_result = f"Tool {function_name} not found"

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "name": function_name,
                        "content": str(tool_result),
                    }
                )

            # Increment depth and continue loop
            current_depth += 1

    async def _call_llm_streaming(
        self, model_config: Dict[str, Any], messages: List[Dict[str, str]]
    ) -> AsyncGenerator[str, None]:
        """
        Call LLM API with streaming.

        Supports OpenAI-compatible APIs and Claude API.
        """
        client = await get_http_client()

        model_type = model_config.get("model", "openai")
        api_key = model_config.get("api_key", "")
        base_url = model_config.get("base_url", "https://api.openai.com/v1")
        model_id = model_config.get("model_id", "gpt-4")
        default_headers = model_config.get("default_headers", {})

        # API key is required unless DEFAULT_HEADERS provides authentication
        if not api_key and not default_headers:
            raise ValueError(
                "API key is required (or DEFAULT_HEADERS must be provided)"
            )

        # Build request based on model type
        if model_type == "claude":
            async for chunk in self._call_claude_streaming(
                client, api_key, base_url, model_id, messages, default_headers
            ):
                yield chunk
        elif model_type == "gemini":
            async for chunk in self._call_gemini_streaming(
                client, api_key, base_url, model_id, messages, default_headers
            ):
                yield chunk
        else:
            async for chunk in self._call_openai_streaming(
                client, api_key, base_url, model_id, messages, default_headers
            ):
                yield chunk

    async def _call_llm_streaming_with_cancel(
        self,
        model_config: Dict[str, Any],
        messages: List[Dict[str, str]],
        subtask_id: int,
        cancel_event: asyncio.Event,
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Call LLM API with streaming and cancellation support.
        """
        client = await get_http_client()

        model_type = model_config.get("model", "openai")
        api_key = model_config.get("api_key", "")
        base_url = model_config.get("base_url", "https://api.openai.com/v1")
        model_id = model_config.get("model_id", "gpt-4")
        default_headers = model_config.get("default_headers", {})

        # API key is required unless DEFAULT_HEADERS provides authentication
        if not api_key and not default_headers:
            raise ValueError(
                "API key is required (or DEFAULT_HEADERS must be provided)"
            )

        # Build request based on model type with cancellation support
        if model_type == "claude":
            async for chunk in self._call_claude_streaming_with_cancel(
                client,
                api_key,
                base_url,
                model_id,
                messages,
                default_headers,
                subtask_id,
                cancel_event,
                tools=tools,
            ):
                # Check cancellation before yielding each chunk
                if cancel_event.is_set():
                    return
                yield chunk
        elif model_type == "gemini":
            async for chunk in self._call_gemini_streaming_with_cancel(
                client,
                api_key,
                base_url,
                model_id,
                messages,
                default_headers,
                subtask_id,
                cancel_event,
                tools=tools,
            ):
                # Check cancellation before yielding each chunk
                if cancel_event.is_set():
                    return
                yield chunk
        else:
            async for chunk in self._call_openai_streaming_with_cancel(
                client,
                api_key,
                base_url,
                model_id,
                messages,
                default_headers,
                subtask_id,
                cancel_event,
                tools=tools,
            ):
                # Check cancellation before yielding each chunk
                if cancel_event.is_set():
                    return
                yield chunk

    async def _call_openai_streaming(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Call OpenAI-compatible API with streaming.

        Note: Tool messages (role='tool') are converted to 'user' role because:
        1. It maintains natural conversation flow (tool results augment user's question)
        2. Most models expect user/assistant alternation
        3. Tool results are contextual information for answering the user's question
        """
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {
            "Content-Type": "application/json",
        }

        # Only add Authorization header if api_key is provided
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        # Merge default_headers (custom headers take precedence)
        if default_headers:
            headers.update(default_headers)

        # Check if any messages contain vision content (array format)
        processed_messages = []

        supports_vision = any(
            domain in base_url.lower()
            for domain in [
                "api.openai.com",
                "api.anthropic.com",
                "generativelanguage.googleapis.com",
                "copilot.weibo.com",
            ]
        )

        for msg in messages:
            msg_role = msg.get("role", "user")
            content = msg.get("content", "")

            # Handle assistant messages with tool_calls (content may be null)
            if msg_role == "assistant" and "tool_calls" in msg:
                # Keep the assistant message with tool_calls as-is
                processed_messages.append(msg)
            # Keep tool messages as-is with tool role
            elif msg_role == "tool":
                processed_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": msg.get("tool_call_id"),
                        "content": content,
                    }
                )
            elif isinstance(content, list):
                # This is a multi-part content (vision message)
                if supports_vision:
                    # Keep the original vision format
                    processed_messages.append(msg)
                else:
                    # Extract text and note that there's an image
                    text_parts = []
                    image_count = 0
                    for block in content:
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif block.get("type") == "image_url":
                            image_count += 1
                            text_parts.append(
                                f"[用户上传了图片 {image_count},但当前模型不支持图片识别]"
                            )

                    combined_text = "\n".join(text_parts)
                    processed_messages.append(
                        {"role": msg_role, "content": combined_text}
                    )
            else:
                processed_messages.append({"role": msg_role, "content": content})

        payload = {
            "model": model_id,
            "messages": processed_messages,
            "stream": True,
        }

        async with client.stream(
            "POST", url, json=payload, headers=headers
        ) as response:
            if response.status_code >= 400:
                error_body = await response.aread()
                logger.error(
                    f"OpenAI API error: status={response.status_code}, body={error_body.decode('utf-8', errors='replace')}"
                )
            response.raise_for_status()

            async for line in response.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        choices = chunk_data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield content
                    except json.JSONDecodeError:
                        continue

    async def _call_claude_streaming(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Call Claude API with streaming.

        Note: Claude does not support 'tool' role. Tool messages are converted to 'user' role
        because tool results provide contextual information for answering the user's question.
        """
        base_url_stripped = base_url.rstrip("/")
        if base_url_stripped.endswith("/v1"):
            url = f"{base_url_stripped}/messages"
        else:
            url = f"{base_url_stripped}/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        # Merge default_headers (custom headers take precedence)
        if default_headers:
            headers.update(default_headers)

        # Separate system message from chat messages (Claude API requirement)
        # Convert 'tool' role to 'user' role (Claude doesn't support 'tool' role)
        system_content = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_content = msg["content"]
            else:
                # Convert 'tool' role to 'user' role for Claude
                msg_role = "user" if msg["role"] == "tool" else msg["role"]
                content = msg.get("content", "")
                if isinstance(content, str):
                    formatted_content = [{"type": "text", "text": content}]
                elif isinstance(content, list):
                    formatted_content = []
                    for block in content:
                        if block.get("type") == "text":
                            formatted_content.append(block)
                        elif block.get("type") == "image_url":
                            image_url_data = block.get("image_url", {})
                            if isinstance(image_url_data, dict):
                                image_url = image_url_data.get("url", "")
                            else:
                                image_url = image_url_data

                            if image_url.startswith("data:"):
                                parts = image_url.split(",", 1)
                                if len(parts) == 2:
                                    header = parts[0]
                                    base64_data = parts[1]
                                    media_type = header.split(":")[1].split(";")[0]
                                    formatted_content.append(
                                        {
                                            "type": "image",
                                            "source": {
                                                "type": "base64",
                                                "media_type": media_type,
                                                "data": base64_data,
                                            },
                                        }
                                    )
                else:
                    formatted_content = [{"type": "text", "text": str(content)}]

                chat_messages.append({"role": msg_role, "content": formatted_content})

        payload = {
            "model": model_id,
            "max_tokens": 4096,
            "stream": True,
            "messages": chat_messages,
        }
        if system_content:
            payload["system"] = system_content

        async with client.stream(
            "POST", url, json=payload, headers=headers
        ) as response:
            response.raise_for_status()

            async for line in response.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        if chunk_data.get("type") == "content_block_delta":
                            delta = chunk_data.get("delta", {})
                            if delta.get("type") == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    yield text
                    except json.JSONDecodeError:
                        continue

    async def _call_openai_streaming_with_cancel(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any],
        subtask_id: int,
        cancel_event: asyncio.Event,
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Call OpenAI-compatible API with streaming and cancellation support.
        """
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {
            "Content-Type": "application/json",
        }

        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        if default_headers:
            headers.update(default_headers)

        processed_messages = []

        supports_vision = any(
            domain in base_url.lower()
            for domain in [
                "api.openai.com",
                "api.anthropic.com",
                "generativelanguage.googleapis.com",
                "copilot.weibo.com",
            ]
        )

        for msg in messages:
            msg_role = msg.get("role", "user")
            content = msg.get("content", "")

            # Handle assistant messages with tool_calls (content may be null)
            if msg_role == "assistant" and "tool_calls" in msg:
                # Keep the assistant message with tool_calls as-is
                processed_messages.append(msg)
            # Keep tool messages as-is with tool role
            elif msg_role == "tool":
                processed_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": msg.get("tool_call_id"),
                        "content": content,
                    }
                )
            elif isinstance(content, list):
                if supports_vision:
                    processed_messages.append(msg)
                else:
                    text_parts = []
                    image_count = 0
                    for block in content:
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif block.get("type") == "image_url":
                            image_count += 1
                            text_parts.append(
                                f"[用户上传了图片 {image_count},但当前模型不支持图片识别]"
                            )
                    combined_text = "\n".join(text_parts)
                    processed_messages.append(
                        {"role": msg_role, "content": combined_text}
                    )
            else:
                processed_messages.append({"role": msg_role, "content": content})

        payload = {
            "model": model_id,
            "messages": processed_messages,
            "stream": True,
        }

        if tools:
            payload["tools"] = tools
        # Log the request for debugging
        logger.debug(
            f"OpenAI streaming request: model={model_id}, "
            f"messages={len(processed_messages)}, "
            f"tools={len(tools) if tools else 0}"
        )

        async with client.stream(
            "POST", url, json=payload, headers=headers
        ) as response:
            if response.status_code >= 400:
                error_body = await response.aread()
                logger.error(
                    f"OpenAI API error: status={response.status_code}, body={error_body.decode('utf-8', errors='replace')}"
                )
            response.raise_for_status()

            async for line in response.aiter_lines():
                # Check cancellation at each line
                if cancel_event.is_set():
                    return

                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        choices = chunk_data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})

                            # Handle content
                            content = delta.get("content", "")
                            if content:
                                yield {"type": "content", "content": content}

                            # Handle tool calls
                            tool_calls = delta.get("tool_calls")
                            if tool_calls:
                                for tc in tool_calls:
                                    # Normalize OpenAI tool call format to flat format expected by handler
                                    normalized_tc = {
                                        "index": tc.get("index", 0),
                                        "id": tc.get("id"),
                                    }

                                    if "function" in tc:
                                        func = tc["function"]
                                        if "name" in func:
                                            normalized_tc["name"] = func["name"]
                                        if "arguments" in func:
                                            normalized_tc["arguments"] = func[
                                                "arguments"
                                            ]

                                    yield {
                                        "type": "tool_call_chunk",
                                        "tool_call": normalized_tc,
                                    }
                    except json.JSONDecodeError:
                        continue

    async def _call_gemini_streaming(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Call Gemini API with streaming.

        Gemini uses a different message format:
        - Endpoint: {base_url}/v1beta/models/{model_id}:streamGenerateContent
        - API key is passed as query parameter
        - Messages use 'parts' array instead of 'content' string
        - Role mapping: assistant -> model, tool -> user

        Note: Gemini does not support 'tool' role. Tool messages are converted to 'user' role
        because tool results provide contextual information for answering the user's question.
        """
        # Build URL with API key as query parameter
        base_url_stripped = base_url.rstrip("/")
        # Handle both full URL and base domain cases
        if "generativelanguage.googleapis.com" in base_url_stripped:
            if "/v1beta" in base_url_stripped or "/v1" in base_url_stripped:
                # URL already has version path
                url = f"{base_url_stripped}/models/{model_id}:streamGenerateContent"
            else:
                url = f"{base_url_stripped}/v1beta/models/{model_id}:streamGenerateContent"
        else:
            url = f"{base_url_stripped}/v1beta/models/{model_id}:streamGenerateContent"

        # Add SSE format to query params
        url = f"{url}?alt=sse"

        headers = {
            "Content-Type": "application/json",
        }

        # Add API key to header
        if api_key:
            headers["x-goog-api-key"] = api_key

        # Merge default_headers (custom headers take precedence)
        if default_headers:
            headers.update(default_headers)

        # Convert messages to Gemini format
        system_instruction = None
        gemini_contents = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "system":
                # Gemini uses systemInstruction separately
                if isinstance(content, str):
                    system_instruction = {"parts": [{"text": content}]}
                continue

            # Map roles: assistant -> model, tool -> user (Gemini doesn't support 'tool' role)
            if role == "assistant":
                gemini_role = "model"
            else:
                gemini_role = "user"  # Both 'user' and 'tool' map to 'user'

            # Convert content to parts format
            if isinstance(content, str):
                parts = [{"text": content}]
            elif isinstance(content, list):
                # Handle multi-part content (vision messages)
                parts = []
                for block in content:
                    if block.get("type") == "text":
                        parts.append({"text": block.get("text", "")})
                    elif block.get("type") == "image_url":
                        image_url_data = block.get("image_url", {})
                        if isinstance(image_url_data, dict):
                            image_url = image_url_data.get("url", "")
                        else:
                            image_url = image_url_data

                        # Convert data URL to Gemini inline_data format
                        if image_url.startswith("data:"):
                            data_parts = image_url.split(",", 1)
                            if len(data_parts) == 2:
                                header = data_parts[0]
                                base64_data = data_parts[1]
                                mime_type = header.split(":")[1].split(";")[0]
                                parts.append(
                                    {
                                        "inline_data": {
                                            "mime_type": mime_type,
                                            "data": base64_data,
                                        }
                                    }
                                )
            else:
                parts = [{"text": str(content)}]

            gemini_contents.append({"role": gemini_role, "parts": parts})

        payload = {
            "contents": gemini_contents,
        }

        if system_instruction:
            payload["systemInstruction"] = system_instruction

        async with client.stream(
            "POST", url, json=payload, headers=headers
        ) as response:
            if response.status_code >= 400:
                error_body = await response.aread()
                logger.error(
                    f"Gemini API error: status={response.status_code}, body={error_body.decode('utf-8', errors='replace')}"
                )
            response.raise_for_status()

            async for line in response.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        candidates = chunk_data.get("candidates", [])
                        if candidates:
                            content_obj = candidates[0].get("content", {})
                            parts = content_obj.get("parts", [])
                            for part in parts:
                                text = part.get("text", "")
                                if text:
                                    yield text
                    except json.JSONDecodeError:
                        continue

    async def _call_gemini_streaming_with_cancel(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any],
        subtask_id: int,
        cancel_event: asyncio.Event,
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Call Gemini API with streaming and cancellation support.
        """
        # Build URL with API key as query parameter
        base_url_stripped = base_url.rstrip("/")
        if "generativelanguage.googleapis.com" in base_url_stripped:
            if "/v1beta" in base_url_stripped or "/v1" in base_url_stripped:
                url = f"{base_url_stripped}/models/{model_id}:streamGenerateContent"
            else:
                url = f"{base_url_stripped}/v1beta/models/{model_id}:streamGenerateContent"
        else:
            url = f"{base_url_stripped}/v1beta/models/{model_id}:streamGenerateContent"

        url = f"{url}?alt=sse"

        headers = {
            "Content-Type": "application/json",
        }

        # Add API key to header
        if api_key:
            headers["x-goog-api-key"] = api_key

        if default_headers:
            headers.update(default_headers)

        # Convert tools to Gemini format
        gemini_tools = []
        if tools:
            for tool in tools:
                function = tool.get("function", {})
                gemini_tools.append(
                    {
                        "name": function.get("name"),
                        "description": function.get("description"),
                        "parameters": function.get("parameters"),
                    }
                )

        # Convert messages to Gemini format
        system_instruction = None
        gemini_contents = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "system":
                if isinstance(content, str):
                    system_instruction = {"parts": [{"text": content}]}
                continue

            # Handle assistant message with tool calls
            if role == "assistant" and "tool_calls" in msg:
                parts = []
                if content:
                    parts.append({"text": content})

                for tc in msg["tool_calls"]:
                    tool_name = tc["function"]["name"]
                    tool_args = self._safe_parse_json_args(
                        tc["function"]["arguments"], tool_name, tc.get("id", "unknown")
                    )
                    parts.append(
                        {
                            "functionCall": {
                                "name": tool_name,
                                "args": tool_args,
                            }
                        }
                    )
                gemini_contents.append({"role": "model", "parts": parts})
                continue

            # Handle tool result message
            if role == "tool":
                parts = [
                    {
                        "functionResponse": {
                            "name": msg.get("name"),
                            "response": {"content": content},
                        }
                    }
                ]
                gemini_contents.append({"role": "user", "parts": parts})
                continue

            # Regular messages
            gemini_role = "model" if role == "assistant" else "user"

            if isinstance(content, str):
                parts = [{"text": content}]
            elif isinstance(content, list):
                parts = []
                for block in content:
                    if block.get("type") == "text":
                        parts.append({"text": block.get("text", "")})
                    elif block.get("type") == "image_url":
                        image_url_data = block.get("image_url", {})
                        if isinstance(image_url_data, dict):
                            image_url = image_url_data.get("url", "")
                        else:
                            image_url = image_url_data

                        if image_url.startswith("data:"):
                            data_parts = image_url.split(",", 1)
                            if len(data_parts) == 2:
                                header = data_parts[0]
                                base64_data = data_parts[1]
                                mime_type = header.split(":")[1].split(";")[0]
                                parts.append(
                                    {
                                        "inline_data": {
                                            "mime_type": mime_type,
                                            "data": base64_data,
                                        }
                                    }
                                )
            else:
                parts = [{"text": str(content)}]

            gemini_contents.append({"role": gemini_role, "parts": parts})

        payload = {
            "contents": gemini_contents,
        }

        if gemini_tools:
            payload["tools"] = [{"function_declarations": gemini_tools}]
            # Gemini bug workaround: payload construction duplicated above in original code, fixing it here
            # payload is already set, just adding tools
            # Note: Original code had: payload = { "contents": ... } then if gemini_tools: payload["tools"] = ... then payload = { "contents": ... } (overwrite!).
            # The overwrite at line 1381 in SEARCH block erased tools.
            # Fixed here.

        if system_instruction:
            payload["systemInstruction"] = system_instruction

        async with client.stream(
            "POST", url, json=payload, headers=headers
        ) as response:
            if response.status_code >= 400:
                error_body = await response.aread()
                logger.error(
                    f"Gemini API error: status={response.status_code}, body={error_body.decode('utf-8', errors='replace')}"
                )
            response.raise_for_status()

            async for line in response.aiter_lines():
                # Check cancellation at each line
                if cancel_event.is_set():
                    return

                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        candidates = chunk_data.get("candidates", [])
                        if candidates:
                            content_obj = candidates[0].get("content", {})
                            parts = content_obj.get("parts", [])
                            for part in parts:
                                # Handle text
                                text = part.get("text", "")
                                if text:
                                    yield {"type": "content", "content": text}

                                # Handle function calls
                                if "functionCall" in part:
                                    fc = part["functionCall"]
                                    call_id = f"call_{uuid.uuid4().hex[:8]}"
                                    yield {
                                        "type": "tool_call_chunk",
                                        "tool_call": {
                                            "index": 0,  # Gemini usually returns one
                                            "id": call_id,
                                            "name": fc.get("name"),
                                            "arguments": json.dumps(fc.get("args")),
                                        },
                                    }
                    except json.JSONDecodeError:
                        continue

    async def _call_claude_streaming_with_cancel(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any],
        subtask_id: int,
        cancel_event: asyncio.Event,
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Call Claude API with streaming and cancellation support.
        """
        base_url_stripped = base_url.rstrip("/")
        if base_url_stripped.endswith("/v1"):
            url = f"{base_url_stripped}/messages"
        else:
            url = f"{base_url_stripped}/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        if default_headers:
            headers.update(default_headers)

        # Convert tools to Claude format
        claude_tools = []
        if tools:
            for tool in tools:
                function = tool.get("function", {})
                claude_tools.append(
                    {
                        "name": function.get("name"),
                        "description": function.get("description"),
                        "input_schema": function.get("parameters"),
                    }
                )

        # Convert messages to Claude format
        system_content = ""
        chat_messages = []
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")

            if role == "system":
                system_content = content
                continue

            # Handle assistant message with tool calls
            if role == "assistant" and "tool_calls" in msg:
                tool_calls = msg["tool_calls"]
                formatted_content = []
                # Add text content if present
                if content:
                    formatted_content.append({"type": "text", "text": content})

                # Add tool use blocks
                for tc in tool_calls:
                    tool_name = tc["function"]["name"]
                    tool_args = self._safe_parse_json_args(
                        tc["function"]["arguments"], tool_name, tc["id"]
                    )
                    formatted_content.append(
                        {
                            "type": "tool_use",
                            "id": tc["id"],
                            "name": tool_name,
                            "input": tool_args,
                        }
                    )
                chat_messages.append(
                    {"role": "assistant", "content": formatted_content}
                )
                continue

            # Handle tool result message
            if role == "tool":
                formatted_content = [
                    {
                        "type": "tool_result",
                        "tool_use_id": msg.get("tool_call_id"),
                        "content": content,
                    }
                ]
                chat_messages.append({"role": "user", "content": formatted_content})
                continue

            # Regular user/assistant message
            if isinstance(content, str):
                formatted_content = [{"type": "text", "text": content}]
            elif isinstance(content, list):
                formatted_content = []
                for block in content:
                    if block.get("type") == "text":
                        formatted_content.append(block)
                    elif block.get("type") == "image_url":
                        image_url_data = block.get("image_url", {})
                        if isinstance(image_url_data, dict):
                            image_url = image_url_data.get("url", "")
                        else:
                            image_url = image_url_data

                        if image_url.startswith("data:"):
                            parts = image_url.split(",", 1)
                            if len(parts) == 2:
                                header = parts[0]
                                base64_data = parts[1]
                                media_type = header.split(":")[1].split(";")[0]
                                formatted_content.append(
                                    {
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": media_type,
                                            "data": base64_data,
                                        },
                                    }
                                )
            else:
                formatted_content = [{"type": "text", "text": str(content)}]

            chat_messages.append({"role": role, "content": formatted_content})

        payload = {
            "model": model_id,
            "max_tokens": 4096,
            "stream": True,
            "messages": chat_messages,
        }

        if claude_tools:
            payload["tools"] = claude_tools
            if system_content:
                payload["system"] = system_content
        elif system_content:
            payload["system"] = system_content

        async with client.stream(
            "POST", url, json=payload, headers=headers
        ) as response:
            response.raise_for_status()

            async for line in response.aiter_lines():
                # Check cancellation at each line
                if cancel_event.is_set():
                    return

                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk_data = json.loads(data)
                        event_type = chunk_data.get("type")

                        if event_type == "content_block_start":
                            # Start of a block (could be text or tool_use)
                            index = chunk_data.get("index", 0)
                            content_block = chunk_data.get("content_block", {})
                            if content_block.get("type") == "tool_use":
                                yield {
                                    "type": "tool_call_chunk",
                                    "tool_call": {
                                        "index": index,
                                        "id": content_block.get("id"),
                                        "name": content_block.get("name"),
                                        "arguments": "",  # Arguments come in deltas
                                    },
                                }

                        elif event_type == "content_block_delta":
                            # Delta update
                            index = chunk_data.get("index", 0)
                            delta = chunk_data.get("delta", {})
                            if delta.get("type") == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    yield {"type": "content", "content": text}

                            elif delta.get("type") == "input_json_delta":
                                partial_json = delta.get("partial_json", "")
                                if partial_json:
                                    yield {
                                        "type": "tool_call_chunk",
                                        "tool_call": {
                                            "index": index,
                                            "arguments": partial_json,
                                        },
                                    }

                    except json.JSONDecodeError:
                        continue

    async def _update_subtask_status(
        self,
        subtask_id: int,
        status: str,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ):
        """
        Update subtask status asynchronously (fire-and-forget).

        This method schedules the database update in a thread pool and returns
        immediately without waiting for completion. Use _update_subtask_status_sync
        when you need to ensure the update is complete before proceeding.
        """
        loop = asyncio.get_event_loop()

        def _update():
            from app.db.session import SessionLocal
            from app.models.subtask import Subtask, SubtaskStatus

            db = SessionLocal()
            try:
                subtask = db.query(Subtask).get(subtask_id)
                if subtask:
                    subtask.status = SubtaskStatus(status)
                    subtask.updated_at = datetime.now()

                    if result is not None:
                        subtask.result = result

                    if error is not None:
                        subtask.error_message = error

                    if status in ["COMPLETED", "FAILED", "CANCELLED"]:
                        subtask.completed_at = datetime.now()

                    db.commit()

                    # Also update task status
                    self._update_task_status_sync(db, subtask.task_id)
            except Exception as e:
                logger.error(f"Error updating subtask {subtask_id} status: {e}")
                db.rollback()
            finally:
                db.close()

        await loop.run_in_executor(_db_executor, _update)

    async def _update_subtask_status_sync(
        self,
        subtask_id: int,
        status: str,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ):
        """
        Update subtask status synchronously (waits for completion).

        This method waits for the database update to complete before returning.
        Use this when you need to ensure the update is committed before proceeding
        (e.g., before publishing a stream done signal that clients will act on).
        """
        loop = asyncio.get_event_loop()

        def _update():
            from app.db.session import SessionLocal
            from app.models.subtask import Subtask, SubtaskStatus

            db = SessionLocal()
            try:
                subtask = db.query(Subtask).get(subtask_id)
                if subtask:
                    subtask.status = SubtaskStatus(status)
                    subtask.updated_at = datetime.now()

                    if result is not None:
                        subtask.result = result

                    if error is not None:
                        subtask.error_message = error

                    if status in ["COMPLETED", "FAILED", "CANCELLED"]:
                        subtask.completed_at = datetime.now()

                    db.commit()

                    # Also update task status
                    self._update_task_status_sync(db, subtask.task_id)

            except Exception as e:
                logger.error(f"Error updating subtask {subtask_id} status: {e}")
                db.rollback()
                raise  # Re-raise to signal failure
            finally:
                db.close()

        # Wait for the update to complete
        await loop.run_in_executor(_db_executor, _update)

    def _update_task_status_sync(self, db, task_id: int):
        """
        Update task status based on subtask status (synchronous).
        """
        from app.models.kind import Kind
        from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
        from app.schemas.kind import Task

        try:
            task = (
                db.query(Kind)
                .filter(Kind.id == task_id, Kind.kind == "Task", Kind.is_active)
                .first()
            )
            if not task:
                return

            # Get all assistant subtasks
            subtasks = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == task_id, Subtask.role == SubtaskRole.ASSISTANT
                )
                .order_by(Subtask.message_id.asc())
                .all()
            )
            if not subtasks:
                return

            task_crd = Task.model_validate(task.json)

            # Check last subtask status
            last_subtask = subtasks[-1]

            if last_subtask.status == SubtaskStatus.COMPLETED:
                if task_crd.status:
                    task_crd.status.status = "COMPLETED"
                    task_crd.status.progress = 100
                    task_crd.status.result = last_subtask.result
                    task_crd.status.completedAt = datetime.now()
            elif last_subtask.status == SubtaskStatus.FAILED:
                if task_crd.status:
                    task_crd.status.status = "FAILED"
                    task_crd.status.errorMessage = last_subtask.error_message
                    task_crd.status.result = last_subtask.result
            elif last_subtask.status == SubtaskStatus.RUNNING:
                if task_crd.status:
                    task_crd.status.status = "RUNNING"

            if task_crd.status:
                task_crd.status.updatedAt = datetime.now()

            task.json = task_crd.model_dump(mode="json")
            task.updated_at = datetime.now()
            flag_modified(task, "json")

            db.commit()

        except Exception as e:
            logger.error(f"Error updating task {task_id} status: {e}")
            db.rollback()

    async def _save_partial_response(
        self, subtask_id: int, content: str, is_streaming: bool = True
    ):
        """
        Save partial response during streaming.

        This is called periodically during streaming to persist content
        to the database, ensuring data is not lost on refresh or disconnect.

        Args:
            subtask_id: Subtask ID
            content: Current accumulated content
            is_streaming: Whether still streaming (affects result metadata)
        """
        loop = asyncio.get_event_loop()

        def _save():
            from app.db.session import SessionLocal
            from app.models.subtask import Subtask

            db = SessionLocal()
            try:
                subtask = db.query(Subtask).get(subtask_id)
                if subtask:
                    # Update result field with partial content
                    subtask.result = {
                        "value": content,
                        "streaming": is_streaming,  # Mark if still streaming
                    }
                    subtask.updated_at = datetime.now()
                    db.commit()
            except Exception as e:
                logger.error(
                    f"Error saving partial response for subtask {subtask_id}: {e}"
                )
                db.rollback()
            finally:
                db.close()

        await loop.run_in_executor(_db_executor, _save)

    async def _handle_client_disconnect(
        self, subtask_id: int, task_id: int, partial_content: str, user_message: Any
    ):
        """
        Handle client disconnect during streaming.

        Strategy:
        1. Save partial content to database
        2. Mark subtask as COMPLETED (not FAILED) so user sees partial content
        3. Save to chat history for context continuity
        4. Clean up Redis streaming cache

        This allows:
        - User can see partial content when they return
        - Conversation can continue from where it left off
        - No error state, just incomplete response

        Args:
            subtask_id: Subtask ID
            task_id: Task ID
            partial_content: Content accumulated before disconnect
            user_message: Original user message (for chat history)
        """
        logger.info(
            f"Handling client disconnect for subtask {subtask_id}, saved {len(partial_content)} chars"
        )

        # Only save if we have meaningful content
        min_chars = settings.STREAMING_MIN_CHARS_TO_SAVE
        if len(partial_content) < min_chars:
            logger.info(
                f"Partial content too short ({len(partial_content)} < {min_chars}), not saving"
            )
            # Still update status to COMPLETED with empty result
            result = {
                "value": partial_content,
                "incomplete": True,
                "reason": "client_disconnect",
            }
            await self._update_subtask_status(subtask_id, "COMPLETED", result=result)
            await session_manager.delete_streaming_content(subtask_id)
            return

        # 1. Save partial content to database (mark as not streaming)
        await self._save_partial_response(
            subtask_id, partial_content, is_streaming=False
        )

        # 2. Update status to COMPLETED with incomplete flag
        result = {
            "value": partial_content,
            "incomplete": True,
            "reason": "client_disconnect",
        }
        await self._update_subtask_status(subtask_id, "COMPLETED", result=result)

        # 3. Save to chat history (for context continuity)
        if partial_content:
            await session_manager.append_user_and_assistant_messages(
                task_id, user_message, partial_content
            )

        # 4. Clean up Redis streaming cache
        await session_manager.delete_streaming_content(subtask_id)

    async def _flatten_tools(self, tools: List[Any]) -> List[Any]:
        """Extract FunctionTool objects from FastMCP instances."""
        flat_tools = []
        for t in tools:
            if isinstance(t, FastMCP):
                if hasattr(t, "_tool_manager"):
                    # get_tools() is async in newer versions
                    if hasattr(t._tool_manager, "get_tools"):
                        res = t._tool_manager.get_tools()
                        if inspect.iscoroutine(res):
                            tool_dict = await res
                        else:
                            tool_dict = res

                        if isinstance(tool_dict, dict):
                            flat_tools.extend(tool_dict.values())
            else:
                flat_tools.append(t)
        return flat_tools

    def _adapt_tools_for_model(
        self, tools: List[Any], model_type: str
    ) -> List[Dict[str, Any]]:
        """Adapt tools to model-specific format."""
        adapted = []
        for tool in tools:
            # Check if it's a FastMCP FunctionTool (it has name, description, parameters)
            name = getattr(tool, "name", "")
            description = getattr(tool, "description", "")
            parameters = getattr(tool, "parameters", {})

            if (
                model_type == "openai" or model_type == "gemini"
            ):  # Gemini adapter expects OpenAI format
                adapted.append(
                    {
                        "type": "function",
                        "function": {
                            "name": name,
                            "description": description,
                            "parameters": parameters,
                        },
                    }
                )
            elif model_type == "claude":
                adapted.append(
                    {
                        "name": name,
                        "description": description,
                        "input_schema": parameters,
                    }
                )
        return adapted


# Global chat service instance
chat_service = ChatService()
