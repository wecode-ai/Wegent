# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base tool interface and registry for LangChain tools.

Note: Tool invocation is handled automatically by LangGraph's create_react_agent.
This registry is only for tool registration and retrieval.

This module also defines the PromptModifierTool protocol for tools that can
dynamically modify the system prompt during agent execution.
"""

from typing import Protocol, runtime_checkable

from langchain_core.tools.base import BaseTool


@runtime_checkable
class PromptModifierTool(Protocol):
    """Protocol for tools that can dynamically modify the system prompt.

    Tools implementing this protocol can inject additional content into the
    system prompt during agent execution. This is useful for:
    - On-demand skill loading (LoadSkillTool)
    - Dynamic context injection
    - Any tool that needs to modify agent behavior via prompt

    The LangGraphAgentBuilder automatically detects tools implementing this
    protocol from the tool registry and creates a combined prompt modifier.

    Unlike static prompt modification (e.g., KB tools that modify prompt at
    preparation time), this protocol enables dynamic modification - the prompt
    is updated after the tool is called during agent execution.

    Example implementation:
        class MyTool(BaseTool):
            def get_prompt_modification(self) -> str:
                # Return content to append to system prompt
                # Return empty string if no modification needed
                return "Additional instructions..."
    """

    def get_prompt_modification(self) -> str:
        """Get the prompt modification content to inject into system prompt.

        This method is called by the prompt_modifier before each model invocation.
        The returned content will be appended to the system message.

        Returns:
            String content to append to the system prompt.
            Return empty string if no modification is needed.
        """
        ...


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
