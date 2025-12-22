# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP (Model Context Protocol) client using langchain-mcp-adapters SDK.

This module provides a thin wrapper around the official langchain-mcp-adapters
MultiServerMCPClient with async context manager support.
"""

import logging
from typing import Any

from langchain_core.tools.base import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import (
    SSEConnection,
    StdioConnection,
    StreamableHttpConnection,
)

logger = logging.getLogger(__name__)

# Type alias for connection types
Connection = SSEConnection | StdioConnection | StreamableHttpConnection


def build_connections(config: dict[str, dict[str, Any]]) -> dict[str, Connection]:
    """Build connection configs from server configuration dict.

    Args:
        config: MCP servers configuration dict. Format:
            {
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
    builders = {
        "sse": lambda cfg: SSEConnection(
            transport="sse",
            url=cfg["url"],
            headers=cfg.get("headers"),
            timeout=cfg.get("timeout", 30.0),
        ),
        "stdio": lambda cfg: StdioConnection(
            transport="stdio",
            command=cfg["command"],
            args=cfg.get("args", []),
            env=cfg.get("env"),
        ),
        "streamable-http": lambda cfg: StreamableHttpConnection(
            transport="streamable_http",
            url=cfg["url"],
            headers=cfg.get("headers"),
        ),
    }

    connections = {}
    for name, cfg in config.items():
        server_type = cfg.get("type", "sse")
        builder = builders.get(server_type)
        if not builder:
            raise ValueError(f"Unknown MCP server type: {server_type}")
        connections[name] = builder(cfg)

    return connections


class MCPClient:
    """MCP client with async context manager support.

    Wraps langchain-mcp-adapters MultiServerMCPClient for simplified usage.

    Usage:
        async with MCPClient(config) as client:
            tools = client.get_tools()
    """

    def __init__(self, config: dict[str, dict[str, Any]]):
        """Initialize MCP client.

        Args:
            config: MCP servers configuration dict
        """
        self.config = config
        self.connections = build_connections(config) if config else {}
        self._client: MultiServerMCPClient | None = None

    async def __aenter__(self) -> "MCPClient":
        """Async context manager entry - connect to servers."""
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit - disconnect from servers."""
        await self.disconnect()

    async def connect(self) -> None:
        """Connect to all configured MCP servers."""
        if not self.connections:
            return

        self._client = MultiServerMCPClient(connections=self.connections)
        await self._client.__aenter__()
        logger.info("Connected to MCP servers: %s", ", ".join(self.list_servers()))

    async def disconnect(self) -> None:
        """Disconnect from all MCP servers."""
        if self._client:
            await self._client.__aexit__(None, None, None)
            self._client = None
            logger.info("Disconnected from MCP servers")

    def get_tools(self, server_names: list[str] | None = None) -> list[BaseTool]:
        """Get LangChain-compatible tools from connected servers.

        Args:
            server_names: Optional list of server names to filter tools.
                         If None, returns tools from all servers.

        Returns:
            List of LangChain BaseTool instances
        """
        if not self._client:
            return []

        if server_names is None:
            return self._client.get_tools()

        # Collect tools from specified servers
        tools = []
        for name in server_names:
            tools.extend(self._client.get_tools(server_name=name))
        return tools

    def list_servers(self) -> list[str]:
        """List configured server names."""
        return list(self.connections.keys())

    @property
    def is_connected(self) -> bool:
        """Check if client is connected."""
        return self._client is not None
