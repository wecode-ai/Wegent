# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gemini (Google) LLM Provider for Simple Chat."""

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
    """Parse base64 image URL into media type and data."""
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


class GeminiProvider(LLMProvider):
    """Gemini (Google) LLM provider with streaming support."""

    @property
    def provider_name(self) -> str:
        return "gemini"

    def format_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Format messages for Gemini API."""
        formatted = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            # Skip system messages (handled separately)
            if role == "system":
                continue

            # Map OpenAI roles to Gemini roles
            gemini_role = "model" if role == "assistant" else "user"

            # Handle multi-part content (vision)
            if isinstance(content, list):
                parts = []
                for block in content:
                    if block.get("type") == "text":
                        parts.append({"text": block.get("text", "")})
                    elif block.get("type") == "image_url":
                        image_url = _extract_image_url(block)
                        parsed = _parse_base64_image(image_url)
                        if parsed:
                            media_type, base64_data = parsed
                            parts.append(
                                {
                                    "inline_data": {
                                        "mime_type": media_type,
                                        "data": base64_data,
                                    }
                                }
                            )
                formatted.append({"role": gemini_role, "parts": parts})
            else:
                formatted.append({"role": gemini_role, "parts": [{"text": content}]})

        return formatted

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
        """Stream chat completion from Gemini API."""
        base_url = self.config.base_url.rstrip("/")
        url = f"{base_url}/models/{self.config.model_id}:streamGenerateContent"
        url = f"{url}?alt=sse&key={self.config.api_key}"

        formatted_messages = self.format_messages(messages)
        system_prompt = self._extract_system_prompt(messages)

        payload = {"contents": formatted_messages}
        if system_prompt:
            payload["system_instruction"] = {"parts": [{"text": system_prompt}]}

        async for chunk_data in self._stream_sse(
            url, payload, self._build_headers(), cancel_event
        ):
            if "_error" in chunk_data:
                yield StreamChunk(type=ChunkType.ERROR, error=chunk_data["_error"])
                return

            for chunk in self._parse_chunk(chunk_data):
                yield chunk

    def _parse_chunk(self, chunk_data: dict[str, Any]) -> list[StreamChunk]:
        """Parse a streaming chunk from Gemini API."""
        chunks = []
        candidates = chunk_data.get("candidates", [])

        if not candidates:
            return chunks

        content = candidates[0].get("content", {})
        parts = content.get("parts", [])

        for part in parts:
            if text := part.get("text"):
                chunks.append(StreamChunk(type=ChunkType.CONTENT, content=text))

        return chunks
