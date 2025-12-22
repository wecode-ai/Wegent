"""MCP (Model Context Protocol) client implementation using official SDK.

This module replaces custom MCP handling with the official mcp SDK from PyPI.
The official SDK provides robust implementations for:
- stdio transport (local processes)
- SSE transport (Server-Sent Events)
- HTTP transport

Key advantages over custom implementation:
1. Well-tested and maintained by Anthropic
2. Handles edge cases and error conditions
3. Follows MCP specification exactly
4. Receives updates and bug fixes
5. Better performance and resource management
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class MCPTool(BaseModel):
    """MCP tool definition (remains compatible with existing code)."""

    name: str
    description: str
    input_schema: Dict[str, Any]


class MCPSession(ABC):
    """Base class for MCP sessions using official SDK."""

    def __init__(self, server_name: str):
        """Initialize MCP session.

        Args:
            server_name: Name of the MCP server
        """
        self.server_name = server_name
        self.tools: List[MCPTool] = []
        self._sdk_session: Optional[ClientSession] = None

    @abstractmethod
    async def connect(self) -> None:
        """Establish connection to MCP server."""
        pass

    @abstractmethod
    async def disconnect(self) -> None:
        """Close connection to MCP server."""
        pass

    async def list_tools(self) -> List[MCPTool]:
        """List available tools from MCP server.

        Returns:
            List of MCPTool definitions
        """
        if not self._sdk_session:
            raise RuntimeError("Session not connected")

        result = await self._sdk_session.list_tools()

        tools = []
        for tool in result.tools:
            tools.append(
                MCPTool(
                    name=tool.name,
                    description=tool.description or "",
                    input_schema=tool.inputSchema or {},
                )
            )

        return tools

    async def call_tool(
        self, tool_name: str, arguments: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Call a tool on the MCP server.

        Args:
            tool_name: Name of the tool to call
            arguments: Tool arguments

        Returns:
            Tool execution result
        """
        if not self._sdk_session:
            raise RuntimeError("Session not connected")

        result = await self._sdk_session.call_tool(tool_name, arguments)

        # Convert SDK result to dict format
        return {
            "content": [
                {
                    "type": content.type,
                    "text": getattr(content, "text", None),
                }
                for content in result.content
            ],
            "isError": result.isError or False,
        }


class StdioMCPSession(MCPSession):
    """MCP session using stdio transport with official SDK."""

    def __init__(
        self,
        server_name: str,
        command: str,
        args: Optional[List[str]] = None,
        env: Optional[Dict[str, str]] = None,
        read_timeout: float = 30.0,
    ):
        """Initialize stdio MCP session.

        Args:
            server_name: Server name
            command: Command to execute
            args: Optional command arguments
            env: Optional environment variables
            read_timeout: Timeout for operations in seconds
        """
        super().__init__(server_name)
        self.command = command
        self.args = args or []
        self.env = env or {}
        self.read_timeout = read_timeout
        self._stdio_context = None
        self._read_stream = None
        self._write_stream = None

    async def connect(self) -> None:
        """Start the MCP server process using official SDK."""
        try:
            # Create server parameters
            server_params = StdioServerParameters(
                command=self.command, args=self.args, env=self.env
            )

            # Use official SDK stdio_client context manager
            self._stdio_context = stdio_client(server_params)
            self._read_stream, self._write_stream = await self._stdio_context.__aenter__()

            # Create ClientSession
            self._sdk_session = ClientSession(self._read_stream, self._write_stream)

            # Initialize the session
            await self._sdk_session.initialize()

            # Fetch tools list
            self.tools = await self.list_tools()

            logger.info(
                f"Connected to stdio MCP server '{self.server_name}' "
                f"with {len(self.tools)} tools"
            )

        except Exception as e:
            logger.error(
                f"Failed to connect to stdio server '{self.server_name}': {e}",
                exc_info=True,
            )
            await self.disconnect()
            raise

    async def disconnect(self) -> None:
        """Terminate the MCP server process."""
        try:
            if self._stdio_context:
                await self._stdio_context.__aexit__(None, None, None)
                self._stdio_context = None
            self._sdk_session = None
            self._read_stream = None
            self._write_stream = None
        except Exception as e:
            logger.error(
                f"Error disconnecting stdio server '{self.server_name}': {e}",
                exc_info=True,
            )


class SSEMCPSession(MCPSession):
    """MCP session using SSE transport (custom implementation for now).

    Note: Official SDK primarily focuses on stdio. For SSE, we keep the
    custom implementation but could migrate to SDK if SSE support is added.
    """

    def __init__(
        self, server_name: str, url: str, headers: Optional[Dict[str, str]] = None
    ):
        """Initialize SSE MCP session.

        Args:
            server_name: Server name
            url: SSE endpoint URL
            headers: Optional HTTP headers
        """
        super().__init__(server_name)
        self.url = url
        self.headers = headers or {}
        self.client: Optional[httpx.AsyncClient] = None

    async def connect(self) -> None:
        """Connect to SSE endpoint."""
        self.client = httpx.AsyncClient(timeout=30.0)
        # Fetch tools list on connection
        self.tools = await self.list_tools()
        logger.info(
            f"Connected to SSE MCP server '{self.server_name}' "
            f"with {len(self.tools)} tools"
        )

    async def disconnect(self) -> None:
        """Close HTTP client."""
        if self.client:
            await self.client.aclose()
            self.client = None

    async def list_tools(self) -> List[MCPTool]:
        """List tools via SSE endpoint (custom protocol).

        Returns:
            List of MCPTool definitions
        """
        if not self.client:
            raise RuntimeError("Session not connected")

        response = await self.client.post(
            self.url,
            json={"method": "tools/list", "params": {}},
            headers=self.headers,
        )
        response.raise_for_status()
        data = response.json()

        tools = []
        for tool_data in data.get("tools", []):
            tools.append(
                MCPTool(
                    name=tool_data["name"],
                    description=tool_data.get("description", ""),
                    input_schema=tool_data.get("inputSchema", {}),
                )
            )

        return tools

    async def call_tool(
        self, tool_name: str, arguments: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Call tool via SSE endpoint (custom protocol).

        Args:
            tool_name: Tool name
            arguments: Tool arguments

        Returns:
            Tool result
        """
        if not self.client:
            raise RuntimeError("Session not connected")

        response = await self.client.post(
            self.url,
            json={
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": arguments},
            },
            headers=self.headers,
        )
        response.raise_for_status()
        return response.json()


class StreamableHTTPMCPSession(MCPSession):
    """MCP session using Streamable HTTP transport (custom implementation).

    Note: This is a custom transport not in standard MCP spec.
    Keeping existing implementation for backward compatibility.
    """

    def __init__(
        self, server_name: str, url: str, headers: Optional[Dict[str, str]] = None
    ):
        """Initialize Streamable HTTP MCP session.

        Args:
            server_name: Server name
            url: HTTP endpoint URL
            headers: Optional HTTP headers
        """
        super().__init__(server_name)
        self.url = url
        self.headers = headers or {}
        self.client: Optional[httpx.AsyncClient] = None

    async def connect(self) -> None:
        """Connect to HTTP endpoint."""
        self.client = httpx.AsyncClient(timeout=30.0)
        self.tools = await self.list_tools()
        logger.info(
            f"Connected to HTTP MCP server '{self.server_name}' "
            f"with {len(self.tools)} tools"
        )

    async def disconnect(self) -> None:
        """Close HTTP client."""
        if self.client:
            await self.client.aclose()
            self.client = None

    async def list_tools(self) -> List[MCPTool]:
        """List tools via HTTP endpoint.

        Returns:
            List of MCPTool definitions
        """
        if not self.client:
            raise RuntimeError("Session not connected")

        response = await self.client.get(f"{self.url}/tools", headers=self.headers)
        response.raise_for_status()
        data = response.json()

        tools = []
        for tool_data in data.get("tools", []):
            tools.append(
                MCPTool(
                    name=tool_data["name"],
                    description=tool_data.get("description", ""),
                    input_schema=tool_data.get("inputSchema", {}),
                )
            )

        return tools

    async def call_tool(
        self, tool_name: str, arguments: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Call tool via HTTP endpoint.

        Args:
            tool_name: Tool name
            arguments: Tool arguments

        Returns:
            Tool result
        """
        if not self.client:
            raise RuntimeError("Session not connected")

        response = await self.client.post(
            f"{self.url}/tools/{tool_name}", json=arguments, headers=self.headers
        )
        response.raise_for_status()
        return response.json()


class MCPClient:
    """MCP client that manages multiple server sessions using official SDK."""

    def __init__(self):
        """Initialize MCP client."""
        self.sessions: Dict[str, MCPSession] = {}

    async def connect_sse(
        self, server_name: str, url: str, headers: Optional[Dict[str, str]] = None
    ) -> MCPSession:
        """Connect to MCP server via SSE.

        Args:
            server_name: Server name
            url: SSE endpoint URL
            headers: Optional HTTP headers

        Returns:
            MCPSession instance
        """
        session = SSEMCPSession(server_name, url, headers)
        await session.connect()
        self.sessions[server_name] = session
        return session

    async def connect_stdio(
        self,
        server_name: str,
        command: str,
        args: Optional[List[str]] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> MCPSession:
        """Connect to MCP server via stdio using official SDK.

        Args:
            server_name: Server name
            command: Command to execute
            args: Optional command arguments
            env: Optional environment variables

        Returns:
            MCPSession instance
        """
        session = StdioMCPSession(server_name, command, args, env)
        await session.connect()
        self.sessions[server_name] = session
        return session

    async def connect_streamable_http(
        self, server_name: str, url: str, headers: Optional[Dict[str, str]] = None
    ) -> MCPSession:
        """Connect to MCP server via Streamable HTTP.

        Args:
            server_name: Server name
            url: HTTP endpoint URL
            headers: Optional HTTP headers

        Returns:
            MCPSession instance
        """
        session = StreamableHTTPMCPSession(server_name, url, headers)
        await session.connect()
        self.sessions[server_name] = session
        return session

    async def disconnect(self, server_name: str) -> None:
        """Disconnect from MCP server.

        Args:
            server_name: Server name
        """
        session = self.sessions.pop(server_name, None)
        if session:
            await session.disconnect()

    async def disconnect_all(self) -> None:
        """Disconnect from all MCP servers."""
        for session in list(self.sessions.values()):
            await session.disconnect()
        self.sessions.clear()

    def get_session(self, server_name: str) -> Optional[MCPSession]:
        """Get MCP session by server name.

        Args:
            server_name: Server name

        Returns:
            MCPSession or None
        """
        return self.sessions.get(server_name)

    def list_sessions(self) -> List[str]:
        """List connected server names.

        Returns:
            List of server names
        """
        return list(self.sessions.keys())
