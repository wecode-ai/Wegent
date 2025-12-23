# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tool base class and registry for Chat Shell.

This module defines:
- Tool: A simple dataclass representing a callable tool
- ToolRegistry: A registry for managing tools
"""

import inspect
import logging
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)


@dataclass
class Tool:
    """
    Represents a callable tool for LLM function calling.

    Attributes:
        name: Unique tool name
        description: Human-readable description for LLM
        parameters: JSON Schema for tool parameters
        fn: Async or sync callable that executes the tool
    """

    name: str
    description: str
    parameters: dict[str, Any]
    fn: Callable[..., Any]

    async def execute(self, **kwargs: Any) -> str:
        """Execute the tool and return result as string."""
        try:
            if inspect.iscoroutinefunction(self.fn):
                result = await self.fn(**kwargs)
            else:
                result = self.fn(**kwargs)
            return str(result) if result is not None else "Tool executed successfully"
        except Exception as e:
            logger.exception("Tool execution failed: %s", self.name)
            return f"Tool execution failed: {e}"


class ToolRegistry:
    """
    Registry for managing tools.

    Provides methods to register, retrieve, and format tools for different LLM providers.
    """

    # Format templates for different providers
    _FORMATS = {
        "openai": lambda t: {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        },
        "claude": lambda t: {
            "name": t.name,
            "description": t.description,
            "input_schema": t.parameters,
        },
        "gemini": lambda t: {
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
        },
    }

    def __init__(self, tools: list[Tool] | None = None):
        self._tools: dict[str, Tool] = {}
        if tools:
            for tool in tools:
                self.register(tool)

    def register(self, tool: Tool) -> None:
        """Register a tool."""
        self._tools[tool.name] = tool
        logger.debug("Registered tool: %s", tool.name)

    def get(self, name: str) -> Tool | None:
        """Get a tool by name."""
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        """Get all registered tools."""
        return list(self._tools.values())

    def format_for_provider(self, provider: str) -> list[dict[str, Any]]:
        """Format all tools for a specific LLM provider."""
        formatter = self._FORMATS.get(provider, self._FORMATS["openai"])
        return [formatter(t) for t in self._tools.values()]

    @property
    def has_tools(self) -> bool:
        """Check if any tools are registered."""
        return bool(self._tools)

    def __len__(self) -> int:
        return len(self._tools)
