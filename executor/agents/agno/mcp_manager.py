#!/usr/bin/env python
from datetime import timedelta
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, Optional, List, Tuple
from agno.tools.mcp import MCPTools
from agno.tools.mcp import StreamableHTTPClientParams, SSEClientParams, StdioServerParameters
from shared.logger import setup_logger

logger = setup_logger("agno_mcp_manager")


class MCPManager:
    """
    Manages MCP (Model Context Protocol) tools configuration and connections
    """
    
    def __init__(self):
        self.connected_tools: List[MCPTools] = []
    
    async def setup_mcp_tools(self, config: Dict[str, Any]) -> Optional[List[MCPTools]]:
        """
        Setup MCP tools if configured
        
        Args:
            config: Configuration dictionary containing MCP server settings
            
        Returns:
            List of MCP tools if successful, None otherwise
        """
        mcp_servers = self._extract_mcp_servers_config(config)
        if mcp_servers is None:
            return None

        mcp_tools_list = []

        try:
            # Handle dict format where keys are server names and values are server configs
            if isinstance(mcp_servers, dict):
                logger.info(f"MCP Tools configured for servers: {mcp_servers}")
                for server_name, server_config in mcp_servers.items():
                    # Skip if server_config is not a dict
                    if not isinstance(server_config, dict):
                        continue

                    mcp_tools = await self._create_mcp_tools(server_config, server_name)
                    if mcp_tools:
                        mcp_tools_list.append(mcp_tools)

            # Handle list format for backward compatibility
            elif isinstance(mcp_servers, list) and len(mcp_servers) > 0:
                # Use the first server in the list
                server_config = mcp_servers[0]
                mcp_tools = await self._create_mcp_tools(server_config, "default")
                if mcp_tools:
                    mcp_tools_list.append(mcp_tools)

            if mcp_tools_list:
                logger.info("Setting up MCP tools")
                # Connect all MCP tools in the list
                for mcp_tool in mcp_tools_list:
                    logger.info(f"Connecting to MCP server: {mcp_tool}")
                    await mcp_tool.connect()
                    self.connected_tools.append(mcp_tool)

            return mcp_tools_list
        except Exception as e:
            logger.error(f"Failed to setup MCP tools: {str(e)}")

        return None
    
    def _extract_mcp_servers_config(self, config: Dict[str, Any]) -> Optional[Any]:
        """
        Extract MCP servers configuration supporting multiple formats.
        Priority order:
        1) {"mcpServers": {"mcpServers": {...}}}
        2) {"mcp_servers": {"mcp_servers": {...}}}
        3) {"mcpServers": {...}}
        4) {"mcp_servers": {...}}
        5) Fallback: config.get("mcp_servers")
        """
        try:
            candidates: List[Tuple[str, str, Dict[str, Any]]] = []
            for outer_key in ("mcpServers", "mcp_servers"):
                val = config.get(outer_key)
                if isinstance(val, dict):
                    nested = val.get(outer_key)
                    if isinstance(nested, dict) and nested:
                        logger.info(f"Detected double-nested MCP config under '{outer_key}'.")
                        candidates.append(("double", outer_key, nested))
                    else:
                        logger.info(f"Detected single-nested MCP config under '{outer_key}'.")
                        candidates.append(("single", outer_key, val))

            # Priority selection
            for variant, key, cfg in candidates:
                if variant == "double" and key == "mcpServers":
                    return cfg
            for variant, key, cfg in candidates:
                if variant == "double" and key == "mcp_servers":
                    return cfg
            for variant, key, cfg in candidates:
                if variant == "single" and key == "mcpServers":
                    return cfg
            for variant, key, cfg in candidates:
                if variant == "single" and key == "mcp_servers":
                    return cfg

            # Fallback: original behavior
            fallback = config.get("mcp_servers")
            if fallback is not None:
                logger.info("Using fallback 'mcp_servers' configuration.")
                return fallback
        except Exception as e:
            logger.warning(f"Failed to extract MCP servers configuration: {str(e)}")
        return None

    async def _create_mcp_tools(self, server_config: Dict[str, Any], server_name: str) -> Optional[MCPTools]:
        """
        Create MCP tools for a specific server configuration
        
        Args:
            server_config: Server configuration dictionary
            server_name: Name of the server
            
        Returns:
            MCPTools instance if successful, None otherwise
        """
        try:
            mcp_type = server_config.get("type")
            if not mcp_type:
                return None

            if mcp_type == "streamable-http":
                return self._create_streamable_http_tools(server_config)
            elif mcp_type == "sse":
                return self._create_sse_tools(server_config)
            elif mcp_type == "stdio":
                return self._create_stdio_tools(server_config)
            else:
                logger.error(f"Unsupported MCP type: {mcp_type}")
                return None
        except Exception as e:
            logger.error(f"Failed to create MCP tools for server {server_name}: {str(e)}")
            return None
    
    def _create_streamable_http_tools(self, server_config: Dict[str, Any]) -> MCPTools:
        """
        Create MCP tools for streamable HTTP transport
        
        Args:
            server_config: Server configuration dictionary
            
        Returns:
            MCPTools instance
        """
        server_params = StreamableHTTPClientParams(
            url=server_config.get("url"),
            headers=server_config.get("headers", {}),
            timeout=timedelta(seconds=10)
        )
        return MCPTools(transport="streamable-http", server_params=server_params)
    
    def _create_sse_tools(self, server_config: Dict[str, Any]) -> MCPTools:
        """
        Create MCP tools for SSE (Server-Sent Events) transport
        
        Args:
            server_config: Server configuration dictionary
            
        Returns:
            MCPTools instance
        """
        server_params = SSEClientParams(
            url=server_config.get("url"),
            headers=server_config.get("headers", {}),
            timeout=2
        )
        return MCPTools(transport="sse", server_params=server_params)
    
    def _create_stdio_tools(self, server_config: Dict[str, Any]) -> MCPTools:
        """
        Create MCP tools for stdio transport
        
        Args:
            server_config: Server configuration dictionary
            
        Returns:
            MCPTools instance
        """
        # Example stdio configuration:
        # {
        #     "github": {
        #         "env": {
        #             "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_xxxxxxx"
        #         },
        #         "args": [
        #             "run",
        #             "-i",
        #             "--rm",
        #             "-e",
        #             "GITHUB_PERSONAL_ACCESS_TOKEN",
        #             "-e",
        #             "GITHUB_TOOLSETS",
        #             "-e",
        #             "GITHUB_READ_ONLY",
        #             "ghcr.io/github/github-mcp-server"
        #         ],
        #         "command": "docker"
        #     }
        # }
        server_params = StdioServerParameters(
            env=server_config.get("env"),
            args=server_config.get("args", []),
            command=server_config.get("command"),
        )
        return MCPTools(transport="stdio", server_params=server_params)
    
    async def cleanup_tools(self) -> None:
        """
        Clean up all connected MCP tools
        """
        logger.info("Cleaning up MCP tools")
        for tools in self.connected_tools:
            try:
                # Disconnect MCP tools if they have a disconnect method
                if hasattr(tools, 'disconnect'):
                    await tools.disconnect()
            except Exception as e:
                logger.warning(f"Failed to disconnect MCP tools: {str(e)}")
        
        self.connected_tools.clear()
    
    def get_connected_tools_count(self) -> int:
        """
        Get the number of connected MCP tools
        
        Returns:
            Number of connected tools
        """
        return len(self.connected_tools)
    
    def is_tools_connected(self) -> bool:
        """
        Check if any MCP tools are connected
        
        Returns:
            True if tools are connected, False otherwise
        """
        return len(self.connected_tools) > 0