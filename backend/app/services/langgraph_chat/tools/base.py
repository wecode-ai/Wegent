"""Base tool interface and registry."""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List, Type
from pydantic import BaseModel, Field
import asyncio


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
    """Base class for all tools."""

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
            return ToolResult(success=False, output=None, error=f"Tool execution timeout after {self.timeout}s")
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


class ToolRegistry:
    """Registry for managing available tools."""

    def __init__(self):
        """Initialize tool registry."""
        self._tools: Dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        """Register a tool.

        Args:
            tool: Tool instance to register
        """
        self._tools[tool.name] = tool

    def unregister(self, tool_name: str) -> None:
        """Unregister a tool.

        Args:
            tool_name: Name of tool to unregister
        """
        self._tools.pop(tool_name, None)

    def get(self, tool_name: str) -> Optional[BaseTool]:
        """Get tool by name.

        Args:
            tool_name: Tool name

        Returns:
            Tool instance or None
        """
        return self._tools.get(tool_name)

    def list_tools(self) -> List[BaseTool]:
        """List all registered tools.

        Returns:
            List of tool instances
        """
        return list(self._tools.values())

    def to_openai_format(self) -> List[Dict[str, Any]]:
        """Convert all tools to OpenAI format.

        Returns:
            List of OpenAI tool definitions
        """
        return [tool.to_openai_format() for tool in self._tools.values()]

    def to_langchain_format(self) -> List[Dict[str, Any]]:
        """Convert all tools to LangChain format.

        Returns:
            List of LangChain tool definitions
        """
        return [tool.to_langchain_format() for tool in self._tools.values()]

    async def execute_tool(self, tool_name: str, **kwargs) -> ToolResult:
        """Execute a tool by name.

        Args:
            tool_name: Tool name
            **kwargs: Tool parameters

        Returns:
            ToolResult
        """
        tool = self.get(tool_name)
        if not tool:
            return ToolResult(success=False, output=None, error=f"Tool not found: {tool_name}")

        return await tool.execute_with_timeout(**kwargs)


# Global tool registry instance
global_registry = ToolRegistry()
