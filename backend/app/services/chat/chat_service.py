# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Service for Direct LLM API Calls

Supports Claude and OpenAI compatible APIs for pure conversation scenarios.
All operations are fully async for optimal performance with uvicorn workers.
"""

import json
import logging
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx

from app.services.chat.base import DirectChatService, http_client_manager
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)


class ChatService(DirectChatService):
    """
    Direct chat service for LLM API calls.

    Supports:
    - Claude API (native format)
    - OpenAI API and compatible endpoints
    """

    # Model type identifiers
    MODEL_CLAUDE = "claude"
    MODEL_OPENAI = "openai"

    async def chat_stream(
        self,
        task_id: int,
        subtask_id: int,
        prompt: str,
        config: Dict[str, Any],
    ) -> AsyncGenerator[str, None]:
        """
        Execute streaming chat with LLM API.

        Args:
            task_id: Task ID for session management
            subtask_id: Subtask ID for status updates
            prompt: User message
            config: Configuration containing:
                - api_key: API key
                - base_url: Optional custom API endpoint
                - model_id: Model identifier (e.g., claude-3-5-sonnet-20241022)
                - model: Model type ('claude' or 'openai')
                - system_prompt: Optional system prompt

        Yields:
            str: SSE-formatted response chunks
        """
        # Extract configuration
        api_key = config.get("api_key", "")
        base_url = config.get("base_url", "")
        model_id = config.get("model_id", "")
        model_type = config.get("model", self.MODEL_OPENAI)
        system_prompt = config.get("system_prompt", "")

        if not api_key:
            yield self._format_error_event("API key is not configured")
            return

        if not model_id:
            yield self._format_error_event("Model ID is not configured")
            return

        # Clear any previous cancellation flag
        await session_manager.clear_cancelled(task_id)

        # Get message history and append user message
        history = await session_manager.get_chat_history(task_id)
        history.append({"role": "user", "content": prompt})

        full_response = ""

        try:
            # Route to appropriate API handler
            if model_type == self.MODEL_CLAUDE:
                async for chunk in self._call_claude_api(
                    task_id, api_key, base_url, model_id, system_prompt, history
                ):
                    if await session_manager.is_cancelled(task_id):
                        yield self._format_error_event("Request cancelled by user")
                        return
                    full_response += chunk
                    yield self._format_message_event(chunk)
            else:
                # Default to OpenAI compatible API
                async for chunk in self._call_openai_api(
                    task_id, api_key, base_url, model_id, system_prompt, history
                ):
                    if await session_manager.is_cancelled(task_id):
                        yield self._format_error_event("Request cancelled by user")
                        return
                    full_response += chunk
                    yield self._format_message_event(chunk)

            # Save updated history with assistant response
            history.append({"role": "assistant", "content": full_response})
            await session_manager.save_chat_history(task_id, history)

            yield self._format_done_event(full_response)

        except asyncio.CancelledError:
            logger.info(f"Chat stream cancelled for task {task_id}")
            yield self._format_error_event("Request cancelled")
        except httpx.TimeoutException:
            logger.error(f"API call timeout for task {task_id}")
            yield self._format_error_event("API call timeout")
        except httpx.RequestError as e:
            logger.error(f"Network error for task {task_id}: {e}")
            yield self._format_error_event(f"Network error: {str(e)}")
        except Exception as e:
            logger.exception(f"Error in chat stream for task {task_id}: {e}")
            yield self._format_error_event(str(e))

    async def _call_claude_api(
        self,
        task_id: int,
        api_key: str,
        base_url: str,
        model_id: str,
        system_prompt: str,
        messages: List[Dict[str, str]],
    ) -> AsyncGenerator[str, None]:
        """
        Call Claude API with streaming.

        Args:
            task_id: Task ID for cancellation checks
            api_key: Anthropic API key
            base_url: Optional custom API endpoint
            model_id: Model ID (e.g., claude-3-5-sonnet-20241022)
            system_prompt: System prompt
            messages: Message history

        Yields:
            str: Response content chunks
        """
        url = base_url or "https://api.anthropic.com"
        url = f"{url.rstrip('/')}/v1/messages"

        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        payload = {
            "model": model_id,
            "max_tokens": 8192,
            "stream": True,
            "messages": messages,
        }

        if system_prompt:
            payload["system"] = system_prompt

        client = await http_client_manager.get_client()

        async with client.stream("POST", url, headers=headers, json=payload) as response:
            if response.status_code != 200:
                error_text = await response.aread()
                raise Exception(f"Claude API error {response.status_code}: {error_text.decode()}")

            async for line in response.aiter_lines():
                if await session_manager.is_cancelled(task_id):
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
                        if delta.get("type") == "text_delta":
                            yield delta.get("text", "")
                    elif event_type == "error":
                        error_msg = data.get("error", {}).get("message", "Unknown error")
                        raise Exception(f"Claude API error: {error_msg}")

                except json.JSONDecodeError:
                    continue

    async def _call_openai_api(
        self,
        task_id: int,
        api_key: str,
        base_url: str,
        model_id: str,
        system_prompt: str,
        messages: List[Dict[str, str]],
    ) -> AsyncGenerator[str, None]:
        """
        Call OpenAI compatible API with streaming.

        Args:
            task_id: Task ID for cancellation checks
            api_key: OpenAI API key
            base_url: Optional custom API endpoint
            model_id: Model ID (e.g., gpt-4)
            system_prompt: System prompt
            messages: Message history

        Yields:
            str: Response content chunks
        """
        url = base_url or "https://api.openai.com"
        url = f"{url.rstrip('/')}/v1/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        # Prepend system message if provided
        api_messages = []
        if system_prompt:
            api_messages.append({"role": "system", "content": system_prompt})
        api_messages.extend(messages)

        payload = {
            "model": model_id,
            "messages": api_messages,
            "stream": True,
        }

        client = await http_client_manager.get_client()

        async with client.stream("POST", url, headers=headers, json=payload) as response:
            if response.status_code != 200:
                error_text = await response.aread()
                raise Exception(f"OpenAI API error {response.status_code}: {error_text.decode()}")

            async for line in response.aiter_lines():
                if await session_manager.is_cancelled(task_id):
                    break

                if not line or not line.startswith("data: "):
                    continue

                data_str = line[6:]  # Remove 'data: ' prefix
                if data_str == "[DONE]":
                    break

                try:
                    data = json.loads(data_str)
                    choices = data.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content

                except json.JSONDecodeError:
                    continue

    async def cancel(self, task_id: int) -> bool:
        """
        Cancel an ongoing chat request.

        Args:
            task_id: Task ID to cancel

        Returns:
            bool: True if cancellation flag was set
        """
        logger.info(f"Cancelling chat for task {task_id}")
        return await session_manager.set_cancelled(task_id)


# Need to import asyncio for CancelledError
import asyncio

# Global service instance
chat_service = ChatService()
