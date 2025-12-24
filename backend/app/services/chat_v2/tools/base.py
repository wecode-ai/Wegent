# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base tool interface and registry for LangChain tools.

Note: Tool invocation is handled automatically by LangGraph's create_react_agent.
This registry is only for tool registration and retrieval.
"""

from langchain_core.tools.base import BaseTool


class ToolRegistry:
    """Registry for managing LangChain BaseTool instances.

    LangGraph's create_react_agent handles tool invocation automatically,
    so this registry only provides registration and retrieval functionality.
    """

    def __init__(self):
        """Initialize tool registry."""
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """Register a LangChain tool."""
        self._tools[tool.name] = tool

    def unregister(self, tool_name: str) -> None:
        """Unregister a tool by name."""
        self._tools.pop(tool_name, None)

    def get(self, tool_name: str) -> BaseTool | None:
        """Get tool by name, or None if not found."""
        return self._tools.get(tool_name)

    def get_all(self) -> list[BaseTool]:
        """Get all registered tools."""
        return list(self._tools.values())

    def __len__(self) -> int:
        """Return number of registered tools."""
        return len(self._tools)

    def __contains__(self, tool_name: str) -> bool:
        """Check if a tool is registered."""
        return tool_name in self._tools


# Global tool registry instance
global_registry = ToolRegistry()
