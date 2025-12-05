# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell direct chat service.

Provides streaming chat functionality by directly calling LLM APIs
(OpenAI, Claude) without going through the Docker Executor.
"""
import asyncio
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

import httpx
from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.services.chat.base import ChatServiceBase, get_http_client
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)
logger = logging.getLogger(__name__)

# Thread pool for database operations
_db_executor = ThreadPoolExecutor(max_workers=10)

# Semaphore for concurrent chat limit
_chat_semaphore: Optional[asyncio.Semaphore] = None


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
    ) -> StreamingResponse:
        """
        Stream chat response from LLM API.

        Args:
            subtask_id: Subtask ID for status updates
            task_id: Task ID for session history
            message: User message (string or vision dict)
            model_config: Model configuration (api_key, base_url, model_id, model)
            system_prompt: Bot's system prompt

        Returns:
            StreamingResponse with SSE events
        """
        semaphore = _get_chat_semaphore()

        async def generate() -> AsyncGenerator[str, None]:
            acquired = False
            # Register this stream for cancellation support (async for Redis)
            cancel_event = await session_manager.register_stream(subtask_id)

            # Track accumulated response for incremental saving
            full_response = ""
            client_disconnected = False

            try:
                # Try to acquire semaphore with timeout
                try:
                    acquired = await asyncio.wait_for(semaphore.acquire(), timeout=5.0)
                except asyncio.TimeoutError:
                    error_msg = (
                        "Too many concurrent chat requests, please try again later"
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

                # Build messages list
                messages = self._build_messages(history, message, system_prompt)

                # Call LLM API and stream response with cancellation support
                cancelled = False

                # Incremental save timing
                last_redis_save = time.time()
                last_db_save = time.time()
                redis_interval = settings.STREAMING_REDIS_SAVE_INTERVAL
                db_interval = settings.STREAMING_DB_SAVE_INTERVAL

                async for chunk in self._call_llm_streaming_with_cancel(
                    model_config, messages, subtask_id, cancel_event
                ):
                    # Check if cancelled (local event or Redis flag)
                    if cancel_event.is_set() or await session_manager.is_cancelled(
                        subtask_id
                    ):
                        cancelled = True
                        break

                    full_response += chunk

                    try:
                        yield f"data: {json.dumps({'content': chunk, 'done': False})}\n\n"
                    except (GeneratorExit, Exception) as e:
                        # Client disconnected - but continue streaming in background
                        logger.info(
                            f"Client disconnected for subtask {subtask_id}: {type(e).__name__}, continuing in background"
                        )
                        client_disconnected = True
                        # Don't break - continue accumulating content

                    # Publish chunk to Redis Pub/Sub for real-time updates
                    await session_manager.publish_streaming_chunk(subtask_id, chunk)

                    # Incremental save to Redis (high frequency)
                    current_time = time.time()
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

                # Handle different completion scenarios
                if cancelled:
                    # User explicitly cancelled - the cancel endpoint handles saving
                    if not client_disconnected:
                        yield f"data: {json.dumps({'content': '', 'done': True, 'cancelled': True})}\n\n"
                else:
                    # Normal completion (or client disconnected but stream finished)
                    # Save chat history
                    await session_manager.append_user_and_assistant_messages(
                        task_id, message, full_response
                    )

                    # Update status to COMPLETED and wait for it to complete
                    # This ensures the database is updated before we publish the done signal
                    result = {"value": full_response}
                    await self._update_subtask_status_sync(
                        subtask_id, "COMPLETED", result=result
                    )

                    # Clean up Redis streaming cache
                    await session_manager.delete_streaming_content(subtask_id)

                    # Publish stream done signal with result data (no need to read from DB)
                    await session_manager.publish_streaming_done(
                        subtask_id, result=result
                    )

                    # Only yield if client is still connected
                    if not client_disconnected:
                        yield f"data: {json.dumps({'content': '', 'done': True, 'result': result})}\n\n"

            except asyncio.CancelledError:
                # Handle asyncio cancellation (e.g., server shutdown)
                logger.info(f"Stream cancelled (asyncio) for subtask {subtask_id}")
                # Save what we have so far
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
                raise  # Re-raise to properly clean up

            except asyncio.TimeoutError:
                error_msg = "API call timeout"
                logger.error(f"Chat stream timeout for subtask {subtask_id}")
                # Save partial content before marking as failed
                if full_response:
                    await self._save_partial_response(
                        subtask_id, full_response, is_streaming=False
                    )
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)

            except httpx.RequestError as e:
                error_msg = f"Network error: {str(e)}"
                logger.error(f"Chat stream network error for subtask {subtask_id}: {e}")
                # Save partial content before marking as failed
                if full_response:
                    await self._save_partial_response(
                        subtask_id, full_response, is_streaming=False
                    )
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)

            except Exception as e:
                error_msg = str(e)
                logger.error(
                    f"Chat stream error for subtask {subtask_id}: {e}", exc_info=True
                )
                # Save partial content before marking as failed
                if full_response:
                    await self._save_partial_response(
                        subtask_id, full_response, is_streaming=False
                    )
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                await self._update_subtask_status(subtask_id, "FAILED", error=error_msg)

            finally:
                # Cleanup: unregister stream and release semaphore (async for Redis)
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
        has_vision = False

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
            content = msg.get("content", "")
            if isinstance(content, list):
                # This is a multi-part content (vision message)
                has_vision = True

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
                        {"role": msg["role"], "content": combined_text}
                    )
            else:
                processed_messages.append(msg)

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
        system_content = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_content = msg["content"]
            else:
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

                chat_messages.append(
                    {"role": msg["role"], "content": formatted_content}
                )

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
    ) -> AsyncGenerator[str, None]:
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
        has_vision = False

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
            content = msg.get("content", "")
            if isinstance(content, list):
                has_vision = True
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
                        {"role": msg["role"], "content": combined_text}
                    )
            else:
                processed_messages.append(msg)

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
                            content = delta.get("content", "")
                            if content:
                                yield content
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
        - Role mapping: assistant -> model
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

            # Map roles: assistant -> model
            gemini_role = "model" if role == "assistant" else "user"

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
    ) -> AsyncGenerator[str, None]:
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
                                text = part.get("text", "")
                                if text:
                                    yield text
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
    ) -> AsyncGenerator[str, None]:
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

        system_content = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_content = msg["content"]
            else:
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

                chat_messages.append(
                    {"role": msg["role"], "content": formatted_content}
                )

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
                        if chunk_data.get("type") == "content_block_delta":
                            delta = chunk_data.get("delta", {})
                            if delta.get("type") == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    yield text
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

                    logger.debug(
                        f"Subtask {subtask_id} status updated to {status} (sync)"
                    )
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
        from sqlalchemy.orm.attributes import flag_modified

        from app.models.kind import Kind
        from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
        from app.schemas.kind import Task

        try:
            task = (
                db.query(Kind)
                .filter(Kind.id == task_id, Kind.kind == "Task", Kind.is_active == True)
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
                    logger.debug(
                        f"Saved partial response for subtask {subtask_id}: {len(content)} chars, streaming={is_streaming}"
                    )
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


# Global chat service instance
chat_service = ChatService()
