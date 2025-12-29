# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Claude (Anthropic) LLM Provider for Simple Chat."""

import asyncio
import logging
from typing import Any, AsyncGenerator

from app.services.simple_chat.providers.base import (
    ChunkType,
    LLMProvider,
    StreamChunk,
)

logger = logging.getLogger(__name__)


def _parse_base64_image(image_url: str) -> tuple[str, str] | None:
    """
    Parse base64 image URL into media type and data.

    Args:
        image_url: Data URL (e.g., "data:image/png;base64,...")

    Returns:
        tuple of (media_type, base64_data) or None if invalid
    """
    if not image_url.startswith("data:"):
        return None

    parts = image_url.split(",", 1)
    if len(parts) != 2:
        return None

    header, base64_data = parts
    try:
        media_type = header.split(":")[1].split(";")[0]
        return media_type, base64_data
    except (IndexError, ValueError):
        return None


def _extract_image_url(block: dict) -> str:
    """Extract image URL from OpenAI-format image block."""
    image_url_data = block.get("image_url", {})
    return (
        image_url_data.get("url", "")
        if isinstance(image_url_data, dict)
        else image_url_data
    )


class ClaudeProvider(LLMProvider):
    """Claude (Anthropic) LLM provider with streaming support."""

    @property
    def provider_name(self) -> str:
        return "claude"

    def format_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Format messages for Claude API.

        Claude uses a different format than OpenAI:
        - System message is separate from messages array
        - Vision content uses 'source' with base64 data
        """
        formatted = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            # Skip system messages (handled separately)
            if role == "system":
                continue

            # Handle multi-part content (vision)
            if isinstance(content, list):
                claude_content = []
                for block in content:
                    if block.get("type") == "text":
                        claude_content.append(
                            {"type": "text", "text": block.get("text", "")}
                        )
                    elif block.get("type") == "image_url":
                        image_url = _extract_image_url(block)
                        parsed = _parse_base64_image(image_url)
                        if parsed:
                            media_type, base64_data = parsed
                            claude_content.append(
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": media_type,
                                        "data": base64_data,
                                    },
                                }
                            )
                formatted.append({"role": role, "content": claude_content})
            else:
                formatted.append({"role": role, "content": content})

        return formatted

    def _build_headers(self) -> dict[str, str]:
        """Build headers for Claude API."""
        headers = super()._build_headers()
        if self.config.api_key:
            headers["x-api-key"] = self.config.api_key
        headers["anthropic-version"] = "2023-06-01"
        return headers

    def _extract_system_prompt(self, messages: list[dict[str, Any]]) -> str:
        """Extract system prompt from messages."""
        for msg in messages:
            if msg.get("role") == "system":
                return msg.get("content", "")
        return ""

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        cancel_event: asyncio.Event,
    ) -> AsyncGenerator[StreamChunk, None]:
        """Stream chat completion from Claude API."""
        url = f"{self.config.base_url.rstrip('/')}/messages"
        formatted_messages = self.format_messages(messages)
        system_prompt = self._extract_system_prompt(messages)

        payload = {
            "model": self.config.model_id,
            "messages": formatted_messages,
            "max_tokens": self.config.max_tokens,
            "stream": True,
        }
        if system_prompt:
            payload["system"] = system_prompt

        async for chunk_data in self._stream_sse(
            url, payload, self._build_headers(), cancel_event
        ):
            if "_error" in chunk_data:
                yield StreamChunk(type=ChunkType.ERROR, error=chunk_data["_error"])
                return

            for chunk in self._parse_chunk(chunk_data):
                yield chunk

    def _parse_chunk(self, chunk_data: dict[str, Any]) -> list[StreamChunk]:
        """Parse a streaming chunk from Claude API."""
        chunks = []
        event_type = chunk_data.get("type", "")

        if event_type == "content_block_delta":
            delta = chunk_data.get("delta", {})
            if delta.get("type") == "text_delta":
                text = delta.get("text", "")
                if text:
                    chunks.append(StreamChunk(type=ChunkType.CONTENT, content=text))

        elif event_type == "error":
            error = chunk_data.get("error", {})
            error_msg = error.get("message", "Unknown Claude error")
            chunks.append(StreamChunk(type=ChunkType.ERROR, error=error_msg))

        return chunks
