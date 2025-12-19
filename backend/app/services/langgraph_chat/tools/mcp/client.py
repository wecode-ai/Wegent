"""MCP (Model Context Protocol) client implementation.

Supports multiple transport protocols:
- SSE (Server-Sent Events)
- stdio (standard input/output for local processes)
- streamable-http (HTTP streaming)
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional, AsyncIterator
from pydantic import BaseModel
import asyncio
import json
import httpx
import subprocess


class MCPTool(BaseModel):
    """MCP tool definition."""

    name: str
    description: str
    input_schema: Dict[str, Any]


class MCPSession(ABC):
    """Base class for MCP sessions."""

    def __init__(self, server_name: str):
        """Initialize MCP session.

        Args:
            server_name: Name of the MCP server
        """
        self.server_name = server_name
        self.tools: List[MCPTool] = []

    @abstractmethod
    async def connect(self) -> None:
        """Establish connection to MCP server."""
        pass

    @abstractmethod
    async def disconnect(self) -> None:
        """Close connection to MCP server."""
        pass

    @abstractmethod
    async def list_tools(self) -> List[MCPTool]:
        """List available tools from MCP server.

        Returns:
            List of MCPTool definitions
        """
        pass

    @abstractmethod
    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Call a tool on the MCP server.

        Args:
            tool_name: Name of the tool to call
            arguments: Tool arguments

        Returns:
            Tool execution result
        """
        pass


class SSEMCPSession(MCPSession):
    """MCP session using SSE (Server-Sent Events) transport."""

    def __init__(self, server_name: str, url: str, headers: Optional[Dict[str, str]] = None):
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

    async def disconnect(self) -> None:
        """Close HTTP client."""
        if self.client:
            await self.client.aclose()
            self.client = None

    async def list_tools(self) -> List[MCPTool]:
        """List tools via SSE endpoint.

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

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Call tool via SSE endpoint.

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
            json={"method": "tools/call", "params": {"name": tool_name, "arguments": arguments}},
            headers=self.headers,
        )
        response.raise_for_status()
        return response.json()


class StdioMCPSession(MCPSession):
    """MCP session using stdio transport (local process)."""

    def __init__(self, server_name: str, command: str, args: Optional[List[str]] = None, env: Optional[Dict[str, str]] = None):
        """Initialize stdio MCP session.

        Args:
            server_name: Server name
            command: Command to execute
            args: Optional command arguments
            env: Optional environment variables
        """
        super().__init__(server_name)
        self.command = command
        self.args = args or []
        self.env = env or {}
        self.process: Optional[asyncio.subprocess.Process] = None

    async def connect(self) -> None:
        """Start the MCP server process."""
        self.process = await asyncio.create_subprocess_exec(
            self.command,
            *self.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**self.env},
        )

        # Fetch tools list on connection
        self.tools = await self.list_tools()

    async def disconnect(self) -> None:
        """Terminate the MCP server process."""
        if self.process:
            self.process.terminate()
            await self.process.wait()
            self.process = None

    async def _send_request(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Send JSON-RPC request to MCP server.

        Args:
            method: RPC method name
            params: Method parameters

        Returns:
            Response data
        """
        if not self.process or not self.process.stdin or not self.process.stdout:
            raise RuntimeError("Process not running")

        request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        self.process.stdin.write((request + "\n").encode())
        await self.process.stdin.drain()

        response_line = await self.process.stdout.readline()
        response = json.loads(response_line.decode())

        if "error" in response:
            raise RuntimeError(f"MCP error: {response['error']}")

        return response.get("result", {})

    async def list_tools(self) -> List[MCPTool]:
        """List tools via stdio.

        Returns:
            List of MCPTool definitions
        """
        result = await self._send_request("tools/list", {})

        tools = []
        for tool_data in result.get("tools", []):
            tools.append(
                MCPTool(
                    name=tool_data["name"],
                    description=tool_data.get("description", ""),
                    input_schema=tool_data.get("inputSchema", {}),
                )
            )

        return tools

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Call tool via stdio.

        Args:
            tool_name: Tool name
            arguments: Tool arguments

        Returns:
            Tool result
        """
        return await self._send_request("tools/call", {"name": tool_name, "arguments": arguments})


class StreamableHTTPMCPSession(MCPSession):
    """MCP session using Streamable HTTP transport."""

    def __init__(self, server_name: str, url: str, headers: Optional[Dict[str, str]] = None):
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

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Call tool via HTTP endpoint.

        Args:
            tool_name: Tool name
            arguments: Tool arguments

        Returns:
            Tool result
        """
        if not self.client:
            raise RuntimeError("Session not connected")

        response = await self.client.post(f"{self.url}/tools/{tool_name}", json=arguments, headers=self.headers)
        response.raise_for_status()
        return response.json()


class MCPClient:
    """MCP client that manages multiple server sessions."""

    def __init__(self):
        """Initialize MCP client."""
        self.sessions: Dict[str, MCPSession] = {}

    async def connect_sse(self, server_name: str, url: str, headers: Optional[Dict[str, str]] = None) -> MCPSession:
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
        self, server_name: str, command: str, args: Optional[List[str]] = None, env: Optional[Dict[str, str]] = None
    ) -> MCPSession:
        """Connect to MCP server via stdio.

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

    async def connect_streamable_http(self, server_name: str, url: str, headers: Optional[Dict[str, str]] = None) -> MCPSession:
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
