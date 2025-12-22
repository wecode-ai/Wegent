"""Base tool interface and registry."""

import asyncio
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Type, Union

from langchain_core.tools.base import BaseTool as LangChainBaseTool
from pydantic import BaseModel, Field


class ToolInput(BaseModel):
    """Base class for tool input schema."""

    pass


class ToolResult(BaseModel):
    """Tool execution result."""

    success: bool
    output: Any
    error: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class BaseTool(ABC):
    """Base class for custom tools."""

    name: str
    description: str
    input_schema: Type[ToolInput]

    def __init__(self, timeout: int = 30):
        """Initialize tool.

        Args:
            timeout: Execution timeout in seconds
        """
        self.timeout = timeout

    @abstractmethod
    async def execute(self, **kwargs) -> ToolResult:
        """Execute tool with given parameters.

        Args:
            **kwargs: Tool-specific parameters

        Returns:
            ToolResult with execution output
        """
        pass

    async def execute_with_timeout(self, **kwargs) -> ToolResult:
        """Execute tool with timeout protection.

        Args:
            **kwargs: Tool-specific parameters

        Returns:
            ToolResult with execution output or timeout error
        """
        try:
            return await asyncio.wait_for(self.execute(**kwargs), timeout=self.timeout)
        except asyncio.TimeoutError:
            return ToolResult(
                success=False,
                output=None,
                error=f"Tool execution timeout after {self.timeout}s",
            )
        except Exception as e:
            return ToolResult(success=False, output=None, error=str(e))

    def to_openai_format(self) -> Dict[str, Any]:
        """Convert tool to OpenAI function calling format.

        Returns:
            OpenAI tool definition dict
        """
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema.model_json_schema(),
            },
        }

    def to_langchain_format(self) -> Dict[str, Any]:
        """Convert tool to LangChain format.

        Returns:
            LangChain tool definition dict
        """
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema.model_json_schema(),
            "func": self.execute_with_timeout,
        }


# Union type for all supported tool types
AnyTool = Union[BaseTool, LangChainBaseTool]


class ToolRegistry:
    """Registry for managing available tools.

    Supports both custom BaseTool instances and LangChain BaseTool instances.
    """

    def __init__(self):
        """Initialize tool registry."""
        self._custom_tools: Dict[str, BaseTool] = {}
        self._langchain_tools: Dict[str, LangChainBaseTool] = {}

    def register(self, tool: AnyTool) -> None:
        """Register a tool.

        Args:
            tool: Tool instance to register (custom or LangChain)
        """
        if isinstance(tool, LangChainBaseTool):
            self._langchain_tools[tool.name] = tool
        else:
            self._custom_tools[tool.name] = tool

    def unregister(self, tool_name: str) -> None:
        """Unregister a tool.

        Args:
            tool_name: Name of tool to unregister
        """
        self._custom_tools.pop(tool_name, None)
        self._langchain_tools.pop(tool_name, None)

    def get(self, tool_name: str) -> Optional[AnyTool]:
        """Get tool by name.

        Args:
            tool_name: Tool name

        Returns:
            Tool instance or None
        """
        return self._custom_tools.get(tool_name) or self._langchain_tools.get(tool_name)

    def get_all_tools(self) -> List[AnyTool]:
        """List all registered tools.

        Returns:
            List of tool instances (both custom and LangChain)
        """
        return list(self._custom_tools.values()) + list(self._langchain_tools.values())

    def get_custom_tools(self) -> List[BaseTool]:
        """List all custom tools.

        Returns:
            List of custom BaseTool instances
        """
        return list(self._custom_tools.values())

    def get_langchain_tools(self) -> List[LangChainBaseTool]:
        """List all LangChain tools.

        Returns:
            List of LangChain BaseTool instances
        """
        return list(self._langchain_tools.values())

    def list_tools(self) -> List[AnyTool]:
        """List all registered tools.

        Returns:
            List of tool instances
        """
        return self.get_all_tools()

    def to_openai_format(self) -> List[Dict[str, Any]]:
        """Convert all tools to OpenAI format.

        Returns:
            List of OpenAI tool definitions
        """
        result = []
        for tool in self._custom_tools.values():
            result.append(tool.to_openai_format())
        for tool in self._langchain_tools.values():
            # Convert LangChain tools to OpenAI format
            result.append(
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description or "",
                        "parameters": (
                            tool.args_schema.model_json_schema()
                            if tool.args_schema
                            else {"type": "object", "properties": {}}
                        ),
                    },
                }
            )
        return result

    def to_langchain_format(self) -> List[Dict[str, Any]]:
        """Convert all tools to LangChain format.

        Returns:
            List of LangChain tool definitions
        """
        return [tool.to_langchain_format() for tool in self._custom_tools.values()]

    async def execute_tool(self, tool_name: str, **kwargs) -> ToolResult:
        """Execute a tool by name.

        Args:
            tool_name: Tool name
            **kwargs: Tool parameters

        Returns:
            ToolResult
        """
        # Check custom tools first
        custom_tool = self._custom_tools.get(tool_name)
        if custom_tool:
            return await custom_tool.execute_with_timeout(**kwargs)

        # Check LangChain tools
        lc_tool = self._langchain_tools.get(tool_name)
        if lc_tool:
            try:
                result = await lc_tool.ainvoke(kwargs)
                return ToolResult(success=True, output=result)
            except Exception as e:
                return ToolResult(success=False, output=None, error=str(e))

        return ToolResult(
            success=False, output=None, error=f"Tool not found: {tool_name}"
        )


# Global tool registry instance
global_registry = ToolRegistry()
