# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OpenAI-compatible LLM Provider for Simple Chat."""

import asyncio
import logging
from typing import Any, AsyncGenerator

from app.services.simple_chat.providers.base import (
    ChunkType,
    LLMProvider,
    StreamChunk,
)

logger = logging.getLogger(__name__)


class OpenAIProvider(LLMProvider):
    """OpenAI-compatible LLM provider with streaming support."""

    @property
    def provider_name(self) -> str:
        return "openai"

    def format_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Format messages for OpenAI API."""
        processed = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            # Handle multi-part content (vision)
            if isinstance(content, list):
                processed.append(msg)
            else:
                processed.append({"role": role, "content": content})

        return processed

    def _build_headers(self) -> dict[str, str]:
        """Build headers with Authorization."""
        headers = super()._build_headers()
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        return headers

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        cancel_event: asyncio.Event,
    ) -> AsyncGenerator[StreamChunk, None]:
        """Stream chat completion from OpenAI-compatible API."""
        url = f"{self.config.base_url.rstrip('/')}/chat/completions"
        formatted_messages = self.format_messages(messages)

        payload = {
            "model": self.config.model_id,
            "messages": formatted_messages,
            "stream": True,
        }

        async for chunk_data in self._stream_sse(
            url, payload, self._build_headers(), cancel_event
        ):
            if "_error" in chunk_data:
                yield StreamChunk(type=ChunkType.ERROR, error=chunk_data["_error"])
                return

            for chunk in self._parse_chunk(chunk_data):
                yield chunk

    def _parse_chunk(self, chunk_data: dict[str, Any]) -> list[StreamChunk]:
        """Parse a streaming chunk from OpenAI API."""
        chunks = []
        choices = chunk_data.get("choices", [])
        if not choices:
            return chunks

        delta = choices[0].get("delta", {})

        # Handle content
        if content := delta.get("content"):
            chunks.append(StreamChunk(type=ChunkType.CONTENT, content=content))

        return chunks
