# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Claude (Anthropic) LLM Provider."""

import asyncio
import logging
from typing import Any, AsyncGenerator

from app.services.chat.providers.base import (
    ChunkType,
    LLMProvider,
    StreamChunk,
    extract_image_url,
    parse_base64_image,
    parse_json_safe,
)

logger = logging.getLogger(__name__)


class ClaudeProvider(LLMProvider):
    """Claude (Anthropic) LLM provider with streaming and tool calling."""

    @property
    def provider_name(self) -> str:
        return "claude"

    def _build_url(self) -> str:
        """Build the API URL for Claude."""
        base_url = self.config.base_url.rstrip("/")
        return (
            f"{base_url}/messages"
            if base_url.endswith("/v1")
            else f"{base_url}/v1/messages"
        )

    def _build_headers(self) -> dict[str, str]:
        """Build headers for Claude API."""
        headers = {
            "x-api-key": self.config.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        if self.config.default_headers:
            headers.update(self.config.default_headers)
        return headers

    def format_messages(
        self, messages: list[dict[str, Any]]
    ) -> tuple[str, list[dict[str, Any]]]:
        """Format messages for Claude API. Returns (system_content, chat_messages)."""
        system_content = ""
        chat_messages = []

        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")

            if role == "system":
                system_content = content
            elif role == "assistant" and "tool_calls" in msg:
                chat_messages.append(
                    self._format_assistant_tool_message(content, msg["tool_calls"])
                )
            elif role == "tool":
                chat_messages.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": msg.get("tool_call_id"),
                                "content": content,
                            }
                        ],
                    }
                )
            else:
                chat_messages.append(
                    {"role": role, "content": self._format_content_blocks(content)}
                )

        return system_content, chat_messages

    def _format_assistant_tool_message(
        self, content: str, tool_calls: list[dict]
    ) -> dict[str, Any]:
        """Format assistant message with tool calls."""
        formatted = [{"type": "text", "text": content}] if content else []
        for tc in tool_calls:
            formatted.append(
                {
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["function"]["name"],
                    "input": parse_json_safe(
                        tc["function"]["arguments"], tc["function"]["name"]
                    ),
                }
            )
        return {"role": "assistant", "content": formatted}

    def _format_content_blocks(self, content: Any) -> list[dict[str, Any]]:
        """Format content as Claude content blocks."""
        if isinstance(content, str):
            return [{"type": "text", "text": content}]

        if isinstance(content, list):
            formatted = []
            for block in content:
                if block.get("type") == "text":
                    formatted.append(block)
                elif block.get("type") == "image_url":
                    if img := self._convert_image_block(block):
                        formatted.append(img)
            return formatted

        return [{"type": "text", "text": str(content)}]

    def _convert_image_block(self, block: dict) -> dict[str, Any] | None:
        """Convert OpenAI image format to Claude format."""
        if parsed := parse_base64_image(extract_image_url(block)):
            media_type, base64_data = parsed
            return {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": base64_data,
                },
            }
        return None

    def format_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Format tools for Claude API (uses input_schema).

        If tools are already in Claude format (have 'input_schema' key),
        they are returned as-is. Otherwise, they are converted from OpenAI format.
        """
        if not tools:
            return tools

        formatted = []
        for tool in tools:
            # Check if already in Claude format (has input_schema)
            if "input_schema" in tool and "name" in tool:
                formatted.append(tool)
            # Check if it's in OpenAI format (has 'function' key)
            elif "function" in tool:
                func = tool.get("function", {})
                formatted.append(
                    {
                        "name": func.get("name"),
                        "description": func.get("description"),
                        "input_schema": func.get("parameters"),
                    }
                )
            # Check if it's a raw tool definition (has name, description, parameters)
            elif "name" in tool and "parameters" in tool:
                formatted.append(
                    {
                        "name": tool["name"],
                        "description": tool.get("description"),
                        "input_schema": tool["parameters"],
                    }
                )
            else:
                # Unknown format, pass through
                formatted.append(tool)

        return formatted

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        cancel_event: asyncio.Event,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """Stream chat completion from Claude API."""
        system_content, chat_messages = self.format_messages(messages)

        payload = {
            "model": self.config.model_id,
            "max_tokens": self.config.max_tokens,
            "stream": True,
            "messages": chat_messages,
        }
        if tools:
            payload["tools"] = self.format_tools(tools)
        if system_content:
            payload["system"] = system_content

        async for chunk_data in self._stream_sse(
            self._build_url(), payload, self._build_headers(), cancel_event
        ):
            if "_error" in chunk_data:
                yield StreamChunk(type=ChunkType.ERROR, error=chunk_data["_error"])
                return

            for chunk in self._parse_chunk(chunk_data):
                yield chunk

    def _parse_chunk(self, chunk_data: dict[str, Any]) -> list[StreamChunk]:
        """Parse a streaming chunk from Claude API."""
        chunks = []
        event_type = chunk_data.get("type")

        if event_type == "content_block_start":
            index = chunk_data.get("index", 0)
            block = chunk_data.get("content_block", {})
            if block.get("type") == "tool_use":
                chunks.append(
                    StreamChunk(
                        type=ChunkType.TOOL_CALL,
                        tool_call={
                            "index": index,
                            "id": block.get("id"),
                            "name": block.get("name"),
                            "arguments": "",
                        },
                    )
                )

        elif event_type == "content_block_delta":
            index = chunk_data.get("index", 0)
            delta = chunk_data.get("delta", {})

            if delta.get("type") == "text_delta" and (text := delta.get("text")):
                chunks.append(StreamChunk(type=ChunkType.CONTENT, content=text))
            elif delta.get("type") == "input_json_delta" and (
                partial := delta.get("partial_json")
            ):
                chunks.append(
                    StreamChunk(
                        type=ChunkType.TOOL_CALL,
                        tool_call={"index": index, "arguments": partial},
                    )
                )

        return chunks
