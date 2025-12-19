"""MCP tool adapter to convert MCP tools to BaseTool format."""

from typing import Dict, Any, Type
from pydantic import BaseModel, create_model

from ..base import BaseTool, ToolInput, ToolResult
from .client import MCPSession, MCPTool


class MCPToolAdapter(BaseTool):
    """Adapter that wraps an MCP tool as a BaseTool."""

    def __init__(self, mcp_tool: MCPTool, session: MCPSession, timeout: int = 30):
        """Initialize MCP tool adapter.

        Args:
            mcp_tool: MCP tool definition
            session: MCP session for executing the tool
            timeout: Execution timeout
        """
        super().__init__(timeout)
        self.name = mcp_tool.name
        self.description = mcp_tool.description
        self.mcp_tool = mcp_tool
        self.session = session

        # Dynamically create input schema from MCP tool schema
        self.input_schema = self._create_input_schema(mcp_tool.input_schema)

    def _create_input_schema(self, schema: Dict[str, Any]) -> Type[ToolInput]:
        """Dynamically create Pydantic model from JSON schema.

        Args:
            schema: JSON schema for tool input

        Returns:
            Pydantic model class
        """
        # Extract properties from JSON schema
        properties = schema.get("properties", {})
        required = schema.get("required", [])

        # Build field definitions
        fields = {}
        for field_name, field_info in properties.items():
            field_type = self._json_type_to_python_type(field_info.get("type", "string"))
            field_default = ... if field_name in required else None
            fields[field_name] = (field_type, field_default)

        # Create dynamic Pydantic model
        return create_model(f"{self.name}Input", **fields, __base__=ToolInput)

    def _json_type_to_python_type(self, json_type: str) -> Type:
        """Convert JSON Schema type to Python type.

        Args:
            json_type: JSON Schema type string

        Returns:
            Python type
        """
        type_map = {
            "string": str,
            "integer": int,
            "number": float,
            "boolean": bool,
            "array": list,
            "object": dict,
        }
        return type_map.get(json_type, str)

    async def execute(self, **kwargs) -> ToolResult:
        """Execute MCP tool via session.

        Args:
            **kwargs: Tool-specific parameters

        Returns:
            ToolResult with execution output
        """
        try:
            result = await self.session.call_tool(self.mcp_tool.name, kwargs)
            return ToolResult(
                success=True,
                output=result,
                metadata={"server": self.session.server_name, "tool": self.mcp_tool.name},
            )
        except Exception as e:
            return ToolResult(
                success=False,
                output=None,
                error=str(e),
                metadata={"server": self.session.server_name, "tool": self.mcp_tool.name},
            )


def adapt_mcp_tools(session: MCPSession, timeout: int = 30) -> list[BaseTool]:
    """Convert all tools from an MCP session to BaseTools.

    Args:
        session: MCP session with connected server
        timeout: Tool execution timeout

    Returns:
        List of BaseTool instances
    """
    adapted_tools = []
    for mcp_tool in session.tools:
        adapted_tools.append(MCPToolAdapter(mcp_tool, session, timeout))

    return adapted_tools
