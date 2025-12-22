# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base tool interface and registry for LangChain tools."""

from typing import Any

from langchain_core.tools.base import BaseTool


class ToolRegistry:
    """Registry for managing LangChain BaseTool instances."""

    def __init__(self):
        """Initialize tool registry."""
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """Register a LangChain tool.

        Args:
            tool: LangChain BaseTool instance to register
        """
        self._tools[tool.name] = tool

    def unregister(self, tool_name: str) -> None:
        """Unregister a tool.

        Args:
            tool_name: Name of tool to unregister
        """
        self._tools.pop(tool_name, None)

    def get(self, tool_name: str) -> BaseTool | None:
        """Get tool by name.

        Args:
            tool_name: Tool name

        Returns:
            BaseTool instance or None
        """
        return self._tools.get(tool_name)

    def get_all(self) -> list[BaseTool]:
        """List all registered tools.

        Returns:
            List of BaseTool instances
        """
        return list(self._tools.values())

    async def invoke_tool(self, tool_name: str, **kwargs) -> Any:
        """Execute a tool by name.

        Args:
            tool_name: Tool name
            **kwargs: Tool parameters

        Returns:
            Tool output directly (LangChain handles errors)
        """
        tool = self._tools.get(tool_name)
        if tool:
            return await tool.ainvoke(kwargs)

        raise ValueError(f"Tool not found: {tool_name}")


# Global tool registry instance
global_registry = ToolRegistry()
