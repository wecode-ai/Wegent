"""MCP (Model Context Protocol) client implementation using langchain-mcp-adapters SDK.

This module provides a simplified wrapper around the official langchain-mcp-adapters
SDK for managing MCP server connections and tools.
"""

from typing import Any, Dict, List, Optional

from langchain_core.tools.base import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import (
    SSEConnection,
    StdioConnection,
    StreamableHttpConnection,
)


def build_connections(
    config: Dict[str, Dict[str, Any]],
) -> Dict[str, SSEConnection | StdioConnection | StreamableHttpConnection]:
    """Build connection configs from server configuration dict.

    Args:
        config: MCP servers configuration dict
            Format: {
                "server_name": {
                    "type": "sse|stdio|streamable-http",
                    "url": "...",  # for sse/streamable-http
                    "command": "...",  # for stdio
                    "args": [...],  # for stdio
                    "env": {...},  # for stdio
                    "headers": {...}  # for sse/streamable-http
                }
            }

    Returns:
        Dict of server_name to Connection config
    """
    connections = {}

    for server_name, server_config in config.items():
        server_type = server_config.get("type", "sse")

        if server_type == "sse":
            connections[server_name] = SSEConnection(
                transport="sse",
                url=server_config["url"],
                headers=server_config.get("headers"),
                timeout=server_config.get("timeout", 30.0),
            )
        elif server_type == "stdio":
            connections[server_name] = StdioConnection(
                transport="stdio",
                command=server_config["command"],
                args=server_config.get("args", []),
                env=server_config.get("env"),
            )
        elif server_type == "streamable-http":
            connections[server_name] = StreamableHttpConnection(
                transport="streamable_http",
                url=server_config["url"],
                headers=server_config.get("headers"),
            )
        else:
            raise ValueError(f"Unknown MCP server type: {server_type}")

    return connections


class MCPClient:
    """MCP client wrapper using langchain-mcp-adapters SDK.

    This class wraps the MultiServerMCPClient from langchain-mcp-adapters
    to provide a simpler interface for managing MCP server connections.
    """

    def __init__(self, config: Dict[str, Dict[str, Any]]):
        """Initialize MCP client with server configuration.

        Args:
            config: MCP servers configuration dict
        """
        self.config = config
        self.connections = build_connections(config)
        self._client: Optional[MultiServerMCPClient] = None
        self._tools_cache: List[BaseTool] = []

    async def connect(self) -> None:
        """Connect to all configured MCP servers.

        Creates a MultiServerMCPClient and enters its async context.
        """
        self._client = MultiServerMCPClient(connections=self.connections)
        await self._client.__aenter__()
        # Cache tools after connection
        self._tools_cache = self._client.get_tools()

    async def disconnect(self) -> None:
        """Disconnect from all MCP servers."""
        if self._client:
            await self._client.__aexit__(None, None, None)
            self._client = None
            self._tools_cache = []

    def get_tools(self, server_name: Optional[str] = None) -> List[BaseTool]:
        """Get LangChain-compatible tools from connected servers.

        Args:
            server_name: Optional server name to filter tools.
                        If None, returns tools from all servers.

        Returns:
            List of LangChain BaseTool instances
        """
        if not self._client:
            return []

        return self._client.get_tools(server_name=server_name)

    def list_servers(self) -> List[str]:
        """List configured server names.

        Returns:
            List of server names
        """
        return list(self.connections.keys())

    @property
    def is_connected(self) -> bool:
        """Check if client is connected.

        Returns:
            True if connected, False otherwise
        """
        return self._client is not None
