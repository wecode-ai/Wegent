"""MCP session manager for handling multiple MCP server connections."""

from typing import Dict, List, Optional
import asyncio

from .client import MCPClient, MCPSession
from .adapter import adapt_mcp_tools
from ..base import BaseTool


class MCPSessionManager:
    """Manager for MCP server sessions and tools."""

    def __init__(self, config: Dict[str, Dict]):
        """Initialize MCP session manager.

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
        """
        self.config = config
        self.client = MCPClient()
        self.tools_cache: Dict[str, List[BaseTool]] = {}

    async def connect_all(self) -> None:
        """Connect to all configured MCP servers."""
        tasks = []
        for server_name, server_config in self.config.items():
            tasks.append(self._connect_server(server_name, server_config))

        await asyncio.gather(*tasks, return_exceptions=True)

    async def _connect_server(self, server_name: str, server_config: Dict) -> None:
        """Connect to a single MCP server.

        Args:
            server_name: Server name
            server_config: Server configuration
        """
        try:
            server_type = server_config.get("type", "sse")

            if server_type == "sse":
                await self.client.connect_sse(
                    server_name,
                    server_config["url"],
                    server_config.get("headers"),
                )
            elif server_type == "stdio":
                await self.client.connect_stdio(
                    server_name,
                    server_config["command"],
                    server_config.get("args"),
                    server_config.get("env"),
                )
            elif server_type == "streamable-http":
                await self.client.connect_streamable_http(
                    server_name,
                    server_config["url"],
                    server_config.get("headers"),
                )
            else:
                raise ValueError(f"Unknown MCP server type: {server_type}")

            # Cache adapted tools
            session = self.client.get_session(server_name)
            if session:
                self.tools_cache[server_name] = adapt_mcp_tools(session)

        except Exception as e:
            print(f"Failed to connect to MCP server {server_name}: {e}")

    async def disconnect_all(self) -> None:
        """Disconnect from all MCP servers."""
        await self.client.disconnect_all()
        self.tools_cache.clear()

    def get_tools(self, server_names: Optional[List[str]] = None) -> List[BaseTool]:
        """Get tools from specified servers or all servers.

        Args:
            server_names: Optional list of server names to get tools from

        Returns:
            List of BaseTool instances
        """
        if server_names is None:
            # Return all tools
            all_tools = []
            for tools in self.tools_cache.values():
                all_tools.extend(tools)
            return all_tools
        else:
            # Return tools from specified servers
            tools = []
            for server_name in server_names:
                tools.extend(self.tools_cache.get(server_name, []))
            return tools

    def get_session(self, server_name: str) -> Optional[MCPSession]:
        """Get MCP session by server name.

        Args:
            server_name: Server name

        Returns:
            MCPSession or None
        """
        return self.client.get_session(server_name)

    def list_servers(self) -> List[str]:
        """List connected server names.

        Returns:
            List of server names
        """
        return self.client.list_sessions()
