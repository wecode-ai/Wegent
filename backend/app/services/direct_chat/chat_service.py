# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Direct Service.

Provides direct chat functionality for the Chat shell type,
supporting Claude and OpenAI compatible APIs.
"""

import json
import logging
from typing import Any, AsyncIterator, Dict, List, Optional

from app.services.direct_chat.base import DirectChatService, get_http_client
from app.services.direct_chat.session_manager import SessionManager

logger = logging.getLogger(__name__)


class ChatDirectService(DirectChatService):
    """
    Direct chat service for Chat shell type.

    Supports Claude and OpenAI compatible APIs for pure dialogue scenarios.
    Does not support MCP tool calling.
    """

    def __init__(self, task_id: int, subtask_id: int, user_id: int):
        """
        Initialize the Chat direct service.

        Args:
            task_id: The task ID
            subtask_id: The subtask ID
            user_id: The user ID
        """
        super().__init__(task_id, subtask_id, user_id)
        self._cancelled = False
        self._current_response = None

    async def chat_stream(
        self,
        prompt: str,
        config: Dict[str, Any],
        history: Optional[List[Dict[str, str]]] = None,
    ) -> AsyncIterator[str]:
        """
        Send a chat message and stream the response.

        Args:
            prompt: The user prompt/message
            config: Configuration dictionary containing:
                - api_key: API key for the LLM service
                - base_url: Base URL for API calls (optional)
                - model_id: Model identifier (e.g., 'claude-3-5-sonnet-20241022')
                - model: Model type ('claude' or 'openai')
            history: Optional conversation history (if None, fetched from Redis)

        Yields:
            str: SSE-formatted response chunks
        """
        self._cancelled = False

        # Get API configuration
        api_key = config.get("api_key", "")
        base_url = config.get("base_url", "")
        model_id = config.get("model_id", "")
        model_type = config.get("model", "openai")

        if not api_key:
            yield f"data: {json.dumps({'error': 'API key not configured'})}\n\n"
            return

        if not model_id:
            yield f"data: {json.dumps({'error': 'Model ID not configured'})}\n\n"
            return

        # Get or use provided history
        if history is None:
            history = await SessionManager.get_chat_history(self.task_id)

        # Add user message to history
        history.append({"role": "user", "content": prompt})

        try:
            # Route to appropriate API handler
            if model_type == "claude":
                async for chunk in self._call_claude_api(
                    api_key, base_url, model_id, history
                ):
                    if self._cancelled:
                        yield f"data: {json.dumps({'cancelled': True})}\n\n"
                        return
                    yield chunk
            else:
                # Default to OpenAI compatible API
                async for chunk in self._call_openai_api(
                    api_key, base_url, model_id, history
                ):
                    if self._cancelled:
                        yield f"data: {json.dumps({'cancelled': True})}\n\n"
                        return
                    yield chunk

        except Exception as e:
            error_msg = str(e)
            logger.exception(f"Error in chat stream for task {self.task_id}: {error_msg}")
            yield f"data: {json.dumps({'error': error_msg})}\n\n"

    async def _call_claude_api(
        self,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
    ) -> AsyncIterator[str]:
        """
        Call Claude API with streaming.

        Args:
            api_key: Anthropic API key
            base_url: Base URL (default: https://api.anthropic.com)
            model_id: Model identifier
            messages: Conversation messages

        Yields:
            str: SSE-formatted response chunks
        """
        url = f"{base_url or 'https://api.anthropic.com'}/v1/messages"

        # Convert messages to Claude format
        claude_messages = []
        system_prompt = None
        for msg in messages:
            if msg["role"] == "system":
                system_prompt = msg["content"]
            else:
                claude_messages.append({
                    "role": msg["role"],
                    "content": msg["content"]
                })

        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        payload = {
            "model": model_id,
            "messages": claude_messages,
            "max_tokens": 8192,
            "stream": True,
        }

        if system_prompt:
            payload["system"] = system_prompt

        client = await get_http_client()
        full_response = ""

        try:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                self._current_response = response

                if response.status_code != 200:
                    error_text = await response.aread()
                    yield f"data: {json.dumps({'error': f'Claude API error: {response.status_code} - {error_text.decode()}'})}\n\n"
                    return

                async for line in response.aiter_lines():
                    if self._cancelled:
                        break

                    if not line or not line.startswith("data: "):
                        continue

                    data_str = line[6:]  # Remove 'data: ' prefix
                    if data_str == "[DONE]":
                        break

                    try:
                        data = json.loads(data_str)
                        event_type = data.get("type", "")

                        if event_type == "content_block_delta":
                            delta = data.get("delta", {})
                            text = delta.get("text", "")
                            if text:
                                full_response += text
                                yield f"data: {json.dumps({'content': text, 'type': 'content'})}\n\n"

                        elif event_type == "message_stop":
                            # Save assistant response to history
                            await SessionManager.append_message(
                                self.task_id, "assistant", full_response
                            )
                            yield f"data: {json.dumps({'done': True, 'type': 'done'})}\n\n"

                        elif event_type == "error":
                            error_msg = data.get("error", {}).get("message", "Unknown error")
                            yield f"data: {json.dumps({'error': error_msg})}\n\n"

                    except json.JSONDecodeError:
                        continue

        finally:
            self._current_response = None

    async def _call_openai_api(
        self,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
    ) -> AsyncIterator[str]:
        """
        Call OpenAI compatible API with streaming.

        Args:
            api_key: OpenAI API key
            base_url: Base URL (default: https://api.openai.com)
            model_id: Model identifier
            messages: Conversation messages

        Yields:
            str: SSE-formatted response chunks
        """
        url = f"{base_url or 'https://api.openai.com'}/v1/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": model_id,
            "messages": messages,
            "stream": True,
        }

        client = await get_http_client()
        full_response = ""

        try:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                self._current_response = response

                if response.status_code != 200:
                    error_text = await response.aread()
                    yield f"data: {json.dumps({'error': f'OpenAI API error: {response.status_code} - {error_text.decode()}'})}\n\n"
                    return

                async for line in response.aiter_lines():
                    if self._cancelled:
                        break

                    if not line or not line.startswith("data: "):
                        continue

                    data_str = line[6:]  # Remove 'data: ' prefix
                    if data_str == "[DONE]":
                        # Save assistant response to history
                        await SessionManager.append_message(
                            self.task_id, "assistant", full_response
                        )
                        yield f"data: {json.dumps({'done': True, 'type': 'done'})}\n\n"
                        break

                    try:
                        data = json.loads(data_str)
                        choices = data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                full_response += content
                                yield f"data: {json.dumps({'content': content, 'type': 'content'})}\n\n"

                    except json.JSONDecodeError:
                        continue

        finally:
            self._current_response = None

    async def cancel(self) -> bool:
        """
        Cancel the current chat operation.

        Returns:
            bool: True if cancellation was initiated
        """
        self._cancelled = True
        logger.info(f"Cancellation requested for Chat task {self.task_id}")
        return True
