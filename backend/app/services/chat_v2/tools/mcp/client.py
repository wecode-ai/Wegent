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

    As of langchain-mcp-adapters 0.1.0, MultiServerMCPClient no longer supports
    being used as a context manager. This class now uses the new API:
    - client.get_tools() to get all tools directly

    Usage:
        client = MCPClient(config)
        await client.connect()
        tools = client.get_tools()
        await client.disconnect()

    Or with async context manager:
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
        self._tools: list[BaseTool] = []

    async def __aenter__(self) -> "MCPClient":
        """Async context manager entry - connect to servers."""
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit - disconnect from servers."""
        await self.disconnect()

    async def connect(self) -> None:
        """Connect to all configured MCP servers and load tools.

        As of langchain-mcp-adapters 0.1.0, we use client.get_tools() directly
        instead of using the client as a context manager.
        """
        if not self.connections:
            return

        self._client = MultiServerMCPClient(connections=self.connections)
        # Use the new API: get_tools() is now an async method that handles connection
        self._tools = await self._client.get_tools()

        # Add detailed logging for tool registration
        for tool in self._tools:
            logger.info(
                "[MCP] Registered tool: name='%s', description='%s', type='%s'",
                getattr(tool, "name", "UNKNOWN"),
                getattr(tool, "description", "NO_DESCRIPTION"),
                type(tool).__name__,
            )

        logger.info(
            "Connected to MCP servers: %s, loaded %d tools",
            ", ".join(self.list_servers()),
            len(self._tools),
        )

    async def disconnect(self) -> None:
        """Disconnect from all MCP servers.

        Note: With the new API, the client manages connections internally
        during get_tools() calls. We clear our references here.
        """
        if self._client:
            self._client = None
            self._tools = []
            logger.info("Disconnected from MCP servers")

    def get_tools(self, server_names: list[str] | None = None) -> list[BaseTool]:
        """Get LangChain-compatible tools from connected servers.

        Args:
            server_names: Optional list of server names to filter tools.
                         If None, returns tools from all servers.

        Returns:
            List of LangChain BaseTool instances
        """
        if not self._tools:
            return []

        if server_names is None:
            return list(self._tools)

        # Filter tools by server name (tool names are prefixed with server name)
        filtered_tools = []
        for tool in self._tools:
            # Check if tool belongs to any of the specified servers
            for server_name in server_names:
                if tool.name.startswith(f"{server_name}_") or server_name in getattr(
                    tool, "server_name", ""
                ):
                    filtered_tools.append(tool)
                    break
        return filtered_tools

    def list_servers(self) -> list[str]:
        """List configured server names."""
        return list(self.connections.keys())

    @property
    def is_connected(self) -> bool:
        """Check if client has loaded tools."""
        return len(self._tools) > 0
