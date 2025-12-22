"""MCP session manager for handling multiple MCP server connections."""

import logging
from typing import Any, Dict, List, Optional

from langchain_core.tools.base import BaseTool

from .client import MCPClient

logger = logging.getLogger(__name__)


class MCPSessionManager:
    """Manager for MCP server sessions and tools.

    This class provides a high-level interface for managing MCP server
    connections and retrieving tools using the langchain-mcp-adapters SDK.
    """

    def __init__(self, config: Dict[str, Dict[str, Any]]):
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
        self.client = MCPClient(config)

    async def connect_all(self) -> None:
        """Connect to all configured MCP servers."""
        try:
            await self.client.connect()
            logger.info(
                "Successfully connected to MCP servers: %s",
                ", ".join(self.client.list_servers()),
            )
        except Exception as e:
            logger.error("Failed to connect to MCP servers: %s", e, exc_info=True)
            raise

    async def disconnect_all(self) -> None:
        """Disconnect from all MCP servers."""
        try:
            await self.client.disconnect()
            logger.info("Disconnected from all MCP servers")
        except Exception as e:
            logger.error("Error during MCP disconnect: %s", e, exc_info=True)

    def get_tools(self, server_names: Optional[List[str]] = None) -> List[BaseTool]:
        """Get LangChain-compatible tools from specified servers or all servers.

        Args:
            server_names: Optional list of server names to get tools from.
                         If None, returns tools from all servers.

        Returns:
            List of LangChain BaseTool instances
        """
        if server_names is None:
            # Return all tools
            return self.client.get_tools()

        # Return tools from specified servers
        all_tools = []
        for server_name in server_names:
            tools = self.client.get_tools(server_name=server_name)
            all_tools.extend(tools)
        return all_tools

    def list_servers(self) -> List[str]:
        """List connected server names.

        Returns:
            List of server names
        """
        return self.client.list_servers()

    @property
    def is_connected(self) -> bool:
        """Check if manager is connected to servers.

        Returns:
            True if connected, False otherwise
        """
        return self.client.is_connected
