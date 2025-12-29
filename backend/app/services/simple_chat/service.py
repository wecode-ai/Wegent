# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Simple Chat Service - Lightweight LLM chat service.

This service provides basic LLM chat functionality without complex features.
It's designed for simple use cases like wizard prompt testing.
"""

import asyncio
import json
import logging
from typing import Any, AsyncGenerator

from fastapi.responses import StreamingResponse

from app.services.simple_chat.http_client import get_http_client
from app.services.simple_chat.message_builder import MessageBuilder
from app.services.simple_chat.providers import get_provider
from app.services.simple_chat.providers.base import ChunkType

logger = logging.getLogger(__name__)

# SSE response headers
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
}


def _sse_data(data: dict) -> str:
    """Format data as SSE event."""
    return f"data: {json.dumps(data)}\n\n"


class SimpleChatService:
    """
    Simple chat service for lightweight LLM interactions.

    This service provides:
    - Non-streaming chat completion
    - Streaming chat completion (SSE)

    It does NOT provide:
    - Database operations
    - Session management
    - MCP tools
    - Skills
    - Web search
    - Tool calling
    """

    def __init__(self):
        """Initialize the simple chat service."""
        self._message_builder = MessageBuilder()

    async def chat_completion(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        history: list[dict[str, str]] | None = None,
    ) -> str:
        """
        Non-streaming chat completion.

        Args:
            message: User message (string or dict with content)
            model_config: Model configuration dict containing:
                - model: Provider type ('openai', 'claude', 'gemini')
                - api_key: API key
                - base_url: API base URL
                - model_id: Model identifier
                - default_headers: Optional custom headers
            system_prompt: System prompt for the conversation
            history: Optional chat history

        Returns:
            The LLM response as a string

        Raises:
            ValueError: If provider creation fails or LLM returns an error
        """
        # Build messages
        messages = self._message_builder.build_messages(
            history=history or [],
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
            logger.error(f"Simple chat completion error: {e}")
            raise

        return accumulated_content

    async def chat_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        history: list[dict[str, str]] | None = None,
    ) -> StreamingResponse:
        """
        Streaming chat completion via SSE.

        Args:
            message: User message (string or dict with content)
            model_config: Model configuration dict
            system_prompt: System prompt for the conversation
            history: Optional chat history

        Returns:
            StreamingResponse with SSE events:
            - {"content": "...", "done": false} - Content chunks
            - {"content": "", "done": true} - Completion
            - {"error": "..."} - Error message
        """

        async def generate() -> AsyncGenerator[str, None]:
            cancel_event = asyncio.Event()

            try:
                # Build messages
                messages = self._message_builder.build_messages(
                    history=history or [],
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


# Global simple chat service instance
simple_chat_service = SimpleChatService()
