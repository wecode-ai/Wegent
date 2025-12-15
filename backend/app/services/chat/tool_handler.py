# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tool calling handler for Chat Shell.

This module handles the tool calling flow during chat completions:
- Accumulating streaming tool call chunks
- Executing tool calls
- Building messages for tool results
"""

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from app.services.chat.tools.base import Tool, ToolRegistry

logger = logging.getLogger(__name__)


@dataclass
class ToolCall:
    """Represents a tool call from the LLM."""

    id: str
    name: str
    arguments: str
    index: int = 0

    def parse_arguments(self) -> dict[str, Any]:
        """Parse arguments JSON safely."""
        if not self.arguments:
            return {}
        try:
            return json.loads(self.arguments)
        except json.JSONDecodeError as e:
            logger.warning("Failed to parse arguments for %s: %s", self.name, e)
            return {}


@dataclass
class ToolCallAccumulator:
    """Accumulates streaming tool call chunks."""

    calls: dict[int, dict[str, str]] = field(default_factory=dict)

    def add_chunk(self, chunk: dict[str, Any]) -> None:
        """Add a tool call chunk."""
        idx = chunk.get("index", 0)
        if idx not in self.calls:
            self.calls[idx] = {"id": "", "name": "", "arguments": ""}

        for key in ("id", "name"):
            if chunk.get(key):
                self.calls[idx][key] = chunk[key]
        if chunk.get("arguments"):
            self.calls[idx]["arguments"] += chunk["arguments"]

    def get_calls(self) -> list[ToolCall]:
        """Get accumulated tool calls."""
        return [
            ToolCall(id=tc["id"], name=tc["name"], arguments=tc["arguments"], index=idx)
            for idx, tc in sorted(self.calls.items())
        ]

    def has_calls(self) -> bool:
        """Check if any calls were accumulated."""
        return bool(self.calls)

    def clear(self) -> None:
        """Clear accumulated calls."""
        self.calls.clear()


class ToolHandler:
    """
    Handles tool calling flow for chat completions.

    Uses ToolRegistry internally for tool management and formatting.
    """

    def __init__(self, tools: list[Tool] | None = None):
        self._registry = ToolRegistry(tools)

    def format_for_provider(self, provider: str) -> list[dict[str, Any]]:
        """Get tools formatted for a specific LLM provider."""
        return self._registry.format_for_provider(provider)

    async def execute(self, tool_call: ToolCall) -> str:
        """Execute a single tool call."""
        tool = self._registry.get(tool_call.name)
        if not tool:
            logger.warning("Tool not found: %s", tool_call.name)
            return f"Tool not found: {tool_call.name}"

        args = tool_call.parse_arguments()
        logger.info(
            "Executing tool: %s with args: %s",
            tool_call.name,
            json.dumps(args, ensure_ascii=False)[:500],
        )
        result = await tool.execute(**args)
        # Log result (truncate if too long)
        result_preview = result[:1000] + "..." if len(result) > 1000 else result
        logger.info(
            "Tool %s result (%d chars): %s",
            tool_call.name,
            len(result),
            result_preview,
        )
        return result

    async def execute_all(self, tool_calls: list[ToolCall]) -> list[dict[str, Any]]:
        """Execute multiple tool calls and return message format results."""
        logger.info("Executing %d tool calls", len(tool_calls))
        results = []
        for tc in tool_calls:
            result = await self.execute(tc)
            results.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "name": tc.name,
                    "content": result,
                }
            )
        logger.info("All %d tool calls completed", len(tool_calls))
        return results

    @staticmethod
    def build_assistant_message(
        content: str, tool_calls: list[ToolCall]
    ) -> dict[str, Any]:
        """Build an assistant message with tool calls."""
        return {
            "role": "assistant",
            "content": content or None,
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.name, "arguments": tc.arguments},
                }
                for tc in tool_calls
            ],
        }

    @property
    def has_tools(self) -> bool:
        """Check if any tools are available."""
        return self._registry.has_tools
