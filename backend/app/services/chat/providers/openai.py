# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OpenAI-compatible LLM Provider."""

import asyncio
import logging
from typing import Any, AsyncGenerator

from app.services.chat.providers.base import (
    ChunkType,
    LLMProvider,
    StreamChunk,
)

logger = logging.getLogger(__name__)


class OpenAIProvider(LLMProvider):
    """OpenAI-compatible LLM provider with streaming and tool calling."""

    @property
    def provider_name(self) -> str:
        return "openai"

    def format_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Format messages for OpenAI API."""
        processed = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            # Pass through assistant messages with tool_calls
            if role == "assistant" and "tool_calls" in msg:
                processed.append(msg)
            # Format tool result messages
            elif role == "tool":
                processed.append(
                    {
                        "role": "tool",
                        "tool_call_id": msg.get("tool_call_id"),
                        "content": content,
                    }
                )
            # Handle multi-part content (vision)
            elif isinstance(content, list):
                processed.append(msg)
            else:
                processed.append({"role": role, "content": content})

        return processed

    def format_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Format tools for OpenAI API.

        If tools are already in OpenAI format (have 'type' and 'function' keys),
        they are returned as-is. Otherwise, they are wrapped in the OpenAI format.
        """
        if not tools:
            return tools

        formatted = []
        for tool in tools:
            # Check if already in OpenAI format
            if tool.get("type") == "function" and "function" in tool:
                formatted.append(tool)
            # Check if it's a raw tool definition (has name, description, parameters)
            elif "name" in tool and "description" in tool:
                formatted.append(
                    {
                        "type": "function",
                        "function": {
                            "name": tool["name"],
                            "description": tool["description"],
                            "parameters": tool.get("parameters", {}),
                        },
                    }
                )
            else:
                # Unknown format, pass through
                formatted.append(tool)

        return formatted

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
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """Stream chat completion from OpenAI-compatible API."""
        url = f"{self.config.base_url.rstrip('/')}/chat/completions"
        formatted_messages = self.format_messages(messages)

        payload = {
            "model": self.config.model_id,
            "messages": formatted_messages,
            "stream": True,
        }
        if tools:
            payload["tools"] = self.format_tools(tools)

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

        # Handle tool calls
        if tool_calls := delta.get("tool_calls"):
            for tc in tool_calls:
                normalized = {"index": tc.get("index", 0), "id": tc.get("id")}
                if func := tc.get("function"):
                    if "name" in func:
                        normalized["name"] = func["name"]
                    if "arguments" in func:
                        normalized["arguments"] = func["arguments"]
                chunks.append(
                    StreamChunk(type=ChunkType.TOOL_CALL, tool_call=normalized)
                )

        return chunks
