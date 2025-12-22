"""Comparison tests for custom vs SDK MCP implementations.

This test file demonstrates the functionality of both implementations
and helps validate the migration from custom to official SDK.
"""

import asyncio
import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Test both implementations
from backend.app.services.langgraph_chat.tools.mcp.client import (
    MCPClient as CustomMCPClient,
)
from backend.app.services.langgraph_chat.tools.mcp.client import (
    StdioMCPSession as CustomStdioSession,
)
from backend.app.services.langgraph_chat.tools.mcp.client_sdk import (
    MCPClient as SDKMCPClient,
)
from backend.app.services.langgraph_chat.tools.mcp.client_sdk import (
    StdioMCPSession as SDKStdioSession,
)


class MockMCPServer:
    """Mock MCP server for testing both implementations."""

    @staticmethod
    def get_tools_response():
        """Standard tools/list response."""
        return {
            "tools": [
                {
                    "name": "echo",
                    "description": "Echo back a message",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"message": {"type": "string"}},
                        "required": ["message"],
                    },
                },
                {
                    "name": "add",
                    "description": "Add two numbers",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "a": {"type": "number"},
                            "b": {"type": "number"},
                        },
                        "required": ["a", "b"],
                    },
                },
            ]
        }

    @staticmethod
    def get_tool_call_response(tool_name: str, arguments: dict):
        """Standard tools/call response."""
        if tool_name == "echo":
            return {
                "content": [{"type": "text", "text": arguments.get("message", "")}],
                "isError": False,
            }
        elif tool_name == "add":
            result = arguments.get("a", 0) + arguments.get("b", 0)
            return {
                "content": [{"type": "text", "text": str(result)}],
                "isError": False,
            }
        else:
            return {
                "content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}],
                "isError": True,
            }


@pytest.mark.asyncio
class TestCustomImplementation:
    """Test suite for custom MCP implementation (client.py)."""

    async def test_stdio_connection(self):
        """Test stdio connection with custom implementation."""
        with patch("asyncio.create_subprocess_exec") as mock_subprocess:
            # Mock process
            mock_process = MagicMock()
            mock_process.stdin = AsyncMock()
            mock_process.stdout = AsyncMock()
            mock_process.stdin.write = MagicMock()
            mock_process.stdin.drain = AsyncMock()

            # Mock tools/list response
            tools_response = json.dumps(
                {"jsonrpc": "2.0", "id": 1, "result": MockMCPServer.get_tools_response()}
            )
            mock_process.stdout.readline = AsyncMock(
                return_value=(tools_response + "\n").encode()
            )

            mock_subprocess.return_value = mock_process

            # Test connection
            client = CustomMCPClient()
            session = await client.connect_stdio("test-server", "python", ["server.py"])

            assert session.server_name == "test-server"
            assert len(session.tools) == 2
            assert session.tools[0].name == "echo"
            assert session.tools[1].name == "add"

            await client.disconnect_all()

    async def test_tool_call(self):
        """Test tool execution with custom implementation."""
        with patch("asyncio.create_subprocess_exec") as mock_subprocess:
            mock_process = MagicMock()
            mock_process.stdin = AsyncMock()
            mock_process.stdout = AsyncMock()
            mock_process.stdin.write = MagicMock()
            mock_process.stdin.drain = AsyncMock()

            # First call: tools/list
            tools_response = json.dumps(
                {"jsonrpc": "2.0", "id": 1, "result": MockMCPServer.get_tools_response()}
            )

            # Second call: tools/call
            call_response = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": MockMCPServer.get_tool_call_response(
                        "echo", {"message": "hello"}
                    ),
                }
            )

            mock_process.stdout.readline = AsyncMock(
                side_effect=[
                    (tools_response + "\n").encode(),
                    (call_response + "\n").encode(),
                ]
            )

            mock_subprocess.return_value = mock_process

            # Test tool call
            client = CustomMCPClient()
            session = await client.connect_stdio("test-server", "python", ["server.py"])

            result = await session.call_tool("echo", {"message": "hello"})

            assert result["content"][0]["text"] == "hello"
            assert result["isError"] is False

            await client.disconnect_all()


@pytest.mark.asyncio
class TestSDKImplementation:
    """Test suite for official SDK implementation (client_sdk.py)."""

    async def test_stdio_connection(self):
        """Test stdio connection with SDK implementation."""
        with patch(
            "backend.app.services.langgraph_chat.tools.mcp.client_sdk.stdio_client"
        ) as mock_stdio:
            # Mock SDK components
            mock_read_stream = AsyncMock()
            mock_write_stream = AsyncMock()

            mock_context = AsyncMock()
            mock_context.__aenter__ = AsyncMock(
                return_value=(mock_read_stream, mock_write_stream)
            )
            mock_context.__aexit__ = AsyncMock(return_value=None)

            mock_stdio.return_value = mock_context

            # Mock ClientSession
            with patch(
                "backend.app.services.langgraph_chat.tools.mcp.client_sdk.ClientSession"
            ) as mock_session_class:
                mock_session = AsyncMock()
                mock_session.initialize = AsyncMock()

                # Mock list_tools response
                class MockTool:
                    def __init__(self, name, description, schema):
                        self.name = name
                        self.description = description
                        self.inputSchema = schema

                class MockListToolsResult:
                    tools = [
                        MockTool(
                            "echo",
                            "Echo back a message",
                            {
                                "type": "object",
                                "properties": {"message": {"type": "string"}},
                            },
                        ),
                        MockTool(
                            "add",
                            "Add two numbers",
                            {
                                "type": "object",
                                "properties": {
                                    "a": {"type": "number"},
                                    "b": {"type": "number"},
                                },
                            },
                        ),
                    ]

                mock_session.list_tools = AsyncMock(return_value=MockListToolsResult())
                mock_session_class.return_value = mock_session

                # Test connection
                client = SDKMCPClient()
                session = await client.connect_stdio(
                    "test-server", "python", ["server.py"]
                )

                assert session.server_name == "test-server"
                assert len(session.tools) == 2
                assert session.tools[0].name == "echo"
                assert session.tools[1].name == "add"

                await client.disconnect_all()

    async def test_tool_call(self):
        """Test tool execution with SDK implementation."""
        with patch(
            "backend.app.services.langgraph_chat.tools.mcp.client_sdk.stdio_client"
        ) as mock_stdio:
            mock_read_stream = AsyncMock()
            mock_write_stream = AsyncMock()

            mock_context = AsyncMock()
            mock_context.__aenter__ = AsyncMock(
                return_value=(mock_read_stream, mock_write_stream)
            )
            mock_context.__aexit__ = AsyncMock(return_value=None)

            mock_stdio.return_value = mock_context

            with patch(
                "backend.app.services.langgraph_chat.tools.mcp.client_sdk.ClientSession"
            ) as mock_session_class:
                mock_session = AsyncMock()
                mock_session.initialize = AsyncMock()

                # Mock list_tools
                class MockTool:
                    def __init__(self, name, description, schema):
                        self.name = name
                        self.description = description
                        self.inputSchema = schema

                class MockListToolsResult:
                    tools = [
                        MockTool("echo", "Echo back a message", {}),
                    ]

                mock_session.list_tools = AsyncMock(return_value=MockListToolsResult())

                # Mock call_tool
                class MockContent:
                    type = "text"
                    text = "hello"

                class MockCallToolResult:
                    content = [MockContent()]
                    isError = False

                mock_session.call_tool = AsyncMock(return_value=MockCallToolResult())
                mock_session_class.return_value = mock_session

                # Test tool call
                client = SDKMCPClient()
                session = await client.connect_stdio(
                    "test-server", "python", ["server.py"]
                )

                result = await session.call_tool("echo", {"message": "hello"})

                assert result["content"][0]["text"] == "hello"
                assert result["isError"] is False

                await client.disconnect_all()


@pytest.mark.asyncio
class TestImplementationComparison:
    """Compare both implementations to ensure compatibility."""

    async def test_api_compatibility(self):
        """Ensure both implementations have the same public API."""
        # Check class methods
        custom_methods = set(
            [
                m
                for m in dir(CustomStdioSession)
                if not m.startswith("_") and callable(getattr(CustomStdioSession, m))
            ]
        )
        sdk_methods = set(
            [
                m
                for m in dir(SDKStdioSession)
                if not m.startswith("_") and callable(getattr(SDKStdioSession, m))
            ]
        )

        # Core methods should be present in both
        required_methods = {"connect", "disconnect", "list_tools", "call_tool"}
        assert required_methods.issubset(custom_methods)
        assert required_methods.issubset(sdk_methods)

    def test_tool_schema_compatibility(self):
        """Ensure MCPTool schema is consistent."""
        from backend.app.services.langgraph_chat.tools.mcp.client import MCPTool as CustomTool
        from backend.app.services.langgraph_chat.tools.mcp.client_sdk import MCPTool as SDKTool

        # Create tools with same data
        tool_data = {
            "name": "test",
            "description": "Test tool",
            "input_schema": {"type": "object"},
        }

        custom_tool = CustomTool(**tool_data)
        sdk_tool = SDKTool(**tool_data)

        assert custom_tool.name == sdk_tool.name
        assert custom_tool.description == sdk_tool.description
        assert custom_tool.input_schema == sdk_tool.input_schema


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
