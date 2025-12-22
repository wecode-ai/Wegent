# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gemini (Google) LLM Provider."""

import asyncio
import json
import logging
import uuid
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


class GeminiProvider(LLMProvider):
    """Gemini (Google) LLM provider with streaming and tool calling."""

    @property
    def provider_name(self) -> str:
        return "gemini"

    def _build_url(self) -> str:
        """Build the API URL for Gemini."""
        base_url = self.config.base_url.rstrip("/")
        has_version = "/v1beta" in base_url or "/v1" in base_url

        if "generativelanguage.googleapis.com" in base_url and has_version:
            url = f"{base_url}/models/{self.config.model_id}:streamGenerateContent"
        else:
            url = (
                f"{base_url}/v1beta/models/{self.config.model_id}:streamGenerateContent"
            )

        return f"{url}?alt=sse"

    def _build_headers(self) -> dict[str, str]:
        """Build headers for Gemini API."""
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["x-goog-api-key"] = self.config.api_key
        if self.config.default_headers:
            headers.update(self.config.default_headers)
        return headers

    def format_messages(
        self, messages: list[dict[str, Any]]
    ) -> tuple[dict | None, list[dict[str, Any]]]:
        """Format messages for Gemini API. Returns (system_instruction, contents)."""
        system_instruction = None
        contents = []
        # Collect tool responses to group them together
        pending_tool_responses: list[dict[str, Any]] = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "system":
                if isinstance(content, str):
                    system_instruction = {"parts": [{"text": content}]}
            elif role == "assistant" and "tool_calls" in msg:
                # Flush any pending tool responses before adding assistant message
                if pending_tool_responses:
                    contents.append({"role": "user", "parts": pending_tool_responses})
                    pending_tool_responses = []
                contents.append(
                    self._format_assistant_tool_message(
                        content, msg["tool_calls"], msg.get("thought_signatures")
                    )
                )
            elif role == "tool":
                # Collect tool responses to group them in a single user message
                pending_tool_responses.append(
                    {
                        "functionResponse": {
                            "name": msg.get("name"),
                            "response": {"content": content},
                        }
                    }
                )
            else:
                # Flush any pending tool responses before adding user message
                if pending_tool_responses:
                    contents.append({"role": "user", "parts": pending_tool_responses})
                    pending_tool_responses = []
                gemini_role = "model" if role == "assistant" else "user"
                contents.append(
                    {"role": gemini_role, "parts": self._format_parts(content)}
                )

        # Flush any remaining pending tool responses
        if pending_tool_responses:
            contents.append({"role": "user", "parts": pending_tool_responses})

        return system_instruction, contents

    def _format_assistant_tool_message(
        self,
        content: str,
        tool_calls: list[dict],
        thought_signatures: list[str] | None = None,
    ) -> dict[str, Any]:
        """Format assistant message with tool calls and thought signatures."""
        parts = [{"text": content}] if content else []
        for i, tc in enumerate(tool_calls):
            part: dict[str, Any] = {
                "functionCall": {
                    "name": tc["function"]["name"],
                    "args": parse_json_safe(
                        tc["function"]["arguments"], tc["function"]["name"]
                    ),
                }
            }
            # Add thought_signature if available for this tool call
            if thought_signatures and i < len(thought_signatures):
                sig = thought_signatures[i]
                if sig:
                    part["thoughtSignature"] = sig
            parts.append(part)
        return {"role": "model", "parts": parts}

    def _format_parts(self, content: Any) -> list[dict[str, Any]]:
        """Format content as Gemini parts."""
        if isinstance(content, str):
            return [{"text": content}]

        if isinstance(content, list):
            parts = []
            for block in content:
                if block.get("type") == "text":
                    parts.append({"text": block.get("text", "")})
                elif block.get("type") == "image_url":
                    if img := self._convert_image_block(block):
                        parts.append(img)
            return parts

        return [{"text": str(content)}]

    def _convert_image_block(self, block: dict) -> dict[str, Any] | None:
        """Convert OpenAI image format to Gemini format."""
        if parsed := parse_base64_image(extract_image_url(block)):
            mime_type, base64_data = parsed
            return {"inline_data": {"mime_type": mime_type, "data": base64_data}}
        return None

    def format_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Format tools for Gemini API (function_declarations).

        If tools are already in Gemini format (have 'name' at top level without 'function'),
        they are returned as-is. Otherwise, they are converted from OpenAI format.
        """
        if not tools:
            return tools

        formatted = []
        for tool in tools:
            # Check if already in Gemini format (has name, description at top level)
            if "name" in tool and "description" in tool and "function" not in tool:
                formatted.append(tool)
            # Check if it's in OpenAI format (has 'function' key)
            elif "function" in tool:
                func = tool.get("function", {})
                formatted.append(
                    {
                        "name": func.get("name"),
                        "description": func.get("description"),
                        "parameters": func.get("parameters"),
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
        """Stream chat completion from Gemini API."""
        system_instruction, contents = self.format_messages(messages)

        payload = {"contents": contents}
        if tools:
            payload["tools"] = [{"function_declarations": self.format_tools(tools)}]
        if system_instruction:
            payload["systemInstruction"] = system_instruction

        async for chunk_data in self._stream_sse(
            self._build_url(), payload, self._build_headers(), cancel_event
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

        parts = candidates[0].get("content", {}).get("parts", [])
        tool_call_index = 0

        for part in parts:
            if text := part.get("text"):
                # Capture thought_signature from text parts (for non-function-call responses)
                thought_sig = part.get("thoughtSignature")
                chunks.append(
                    StreamChunk(
                        type=ChunkType.CONTENT,
                        content=text,
                        thought_signature=thought_sig,
                    )
                )

            if fc := part.get("functionCall"):
                # Capture thought_signature from function call parts
                # For Gemini 3 Pro, thought_signature is required for function calling
                thought_sig = part.get("thoughtSignature")
                chunks.append(
                    StreamChunk(
                        type=ChunkType.TOOL_CALL,
                        tool_call={
                            "index": tool_call_index,
                            "id": f"call_{uuid.uuid4().hex[:8]}",
                            "name": fc.get("name"),
                            "arguments": json.dumps(fc.get("args", {})),
                        },
                        thought_signature=thought_sig,
                    )
                )
                tool_call_index += 1

        return chunks
