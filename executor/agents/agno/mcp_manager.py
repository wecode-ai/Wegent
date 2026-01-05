#!/usr/bin/env python
import json
from datetime import timedelta
from typing import Any, Dict, List, Optional, Tuple

from agno.tools.mcp import (MCPTools, SSEClientParams, StdioServerParameters,
                            StreamableHTTPClientParams)

from executor.utils.mcp_utils import (extract_mcp_servers_config,
                                      replace_mcp_server_variables)
from shared.logger import setup_logger

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-


logger = setup_logger("agno_mcp_manager")


class MCPManager:
    """
    Manages MCP (Model Context Protocol) tools configuration and connections
    """

    def __init__(self, thinking_manager=None):
        self.connected_tools: List[MCPTools] = []
        self.thinking_manager = thinking_manager

    async def setup_mcp_tools(
        self, config: Dict[str, Any], task_data: Optional[Dict[str, Any]] = None
    ) -> Optional[List[MCPTools]]:
        """
        Setup MCP tools if configured

        Args:
            config: Configuration dictionary containing MCP server settings
            task_data: Optional task data dictionary for variable replacement in MCP config.
                       Supports placeholders like ${{user.name}}, ${{git_repo}}, ${{bot.0.name}}

        Returns:
            List of MCP tools if successful, None otherwise
        """
        mcp_servers = extract_mcp_servers_config(config)
        if mcp_servers is None:
            return None

        # Replace placeholders in MCP servers config with actual values from task_data
        if task_data:
            mcp_servers = replace_mcp_server_variables(mcp_servers, task_data)

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
                    try:
                        await mcp_tool.connect()
                        self.connected_tools.append(mcp_tool)
                    except Exception as connect_error:
                        logger.error(
                            f"[MCP_CONNECT_FAIL] {type(connect_error).__name__}: {str(connect_error)}"
                        )
                        raise

            return mcp_tools_list
        except Exception as e:
            logger.error(f"Failed to setup MCP tools: {str(e)}")
            # Add thinking step for MCP setup failure
            self.add_thinking_step_by_key(
                title_key="thinking.mcp_init_fail",
                report_immediately=True,
                details={
                    "error_message": f"Failed to setup MCP tools. \nerror message: {str(e)}. \ntools: {json.dumps(mcp_servers, ensure_ascii=False)}"
                },
            )

        return None

    async def _create_mcp_tools(
        self, server_config: Dict[str, Any], server_name: str
    ) -> Optional[MCPTools]:
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
                mcp_type = "stdio"

            if mcp_type == "streamable-http" or mcp_type == "streamable_http":
                return self._create_streamable_http_tools(server_config)
            elif mcp_type == "sse":
                return self._create_sse_tools(server_config)
            elif mcp_type == "stdio":
                return self._create_stdio_tools(server_config)
            else:
                logger.error(f"Unsupported MCP type: {mcp_type}")
                return None
        except Exception as e:
            logger.error(
                f"Failed to create MCP tools for server {server_name}: {str(e)}"
            )
            # Add thinking step for MCP tools creation failure
            self.add_thinking_step_by_key(
                title_key="thinking.mcp_init_fail",
                report_immediately=False,
                details={
                    "error_message": f"Failed to create MCP tools for server. error message: {str(e)}",
                    "server_name": server_name,
                },
            )
            return None

    def _create_streamable_http_tools(self, server_config: Dict[str, Any]) -> MCPTools:
        """
        Create MCP tools for streamable HTTP transport

        Args:
            server_config: Server configuration dictionary

        Returns:
            MCPTools instance
        """
        if server_config.get("url") is None:
            logger.error("Server URL is required for streamable HTTP transport")
            # Add thinking step for missing URL configuration
            self.add_thinking_step_by_key(
                title_key="thinking.mcp_init_fail",
                report_immediately=False,
                details={
                    "error_message": "Server URL is required for streamable HTTP transport",
                    "transport_type": "streamable-http",
                },
            )
            return None

        # Set default timeout to 5 minutes, allow user override
        timeout_value = server_config.get("timeout")
        sse_read_timeout_value = server_config.get("sse_read_timeout")
        timeout_seconds = timeout_value if timeout_value is not None else 60 * 5

        server_params = StreamableHTTPClientParams(
            url=server_config.get("url"),
            headers=server_config.get("headers", {}),
            timeout=(
                timedelta(seconds=timeout_value)
                if timeout_value is not None
                else timedelta(seconds=60 * 5)
            ),
            sse_read_timeout=(
                timedelta(seconds=sse_read_timeout_value)
                if sse_read_timeout_value is not None
                else timedelta(seconds=60 * 5)
            ),
        )
        return MCPTools(
            transport="streamable-http",
            server_params=server_params,
            timeout_seconds=timeout_seconds,
        )

    def _create_sse_tools(self, server_config: Dict[str, Any]) -> MCPTools:
        """
        Create MCP tools for SSE (Server-Sent Events) transport

        Args:
            server_config: Server configuration dictionary

        Returns:
            MCPTools instance
        """
        if not server_config.get("url"):
            logger.error("Server URL is required for SSE transport")
            # Add thinking step for missing URL configuration
            self.add_thinking_step_by_key(
                title_key="thinking.mcp_init_fail",
                report_immediately=False,
                details={
                    "error_message": "Server URL is required for SSE transport",
                    "transport_type": "sse",
                },
            )
            return None

        # Set default timeout to 5 minutes, allow user override
        timeout_value = server_config.get("timeout")
        sse_read_timeout_value = server_config.get("sse_read_timeout")
        timeout_seconds = timeout_value if timeout_value is not None else 60 * 5

        server_params = SSEClientParams(
            url=server_config.get("url"),
            headers=server_config.get("headers", {}),
            timeout=timeout_value if timeout_value is not None else 60 * 5,
            sse_read_timeout=(
                sse_read_timeout_value if sse_read_timeout_value is not None else 60 * 5
            ),
        )

        return MCPTools(
            transport="sse",
            server_params=server_params,
            timeout_seconds=timeout_seconds,
        )

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
        if not server_config.get("command"):
            logger.error(
                f"Server command is required for Stdio transport: server_config: {server_config}"
            )
            # Add thinking step for missing command configuration
            self.add_thinking_step_by_key(
                title_key="thinking.mcp_init_fail",
                report_immediately=False,
                details={
                    "error_message": "Server command is required for Stdio transport",
                    "transport_type": "stdio",
                },
            )
            return None
        server_params = StdioServerParameters(
            env=server_config.get("env"),
            args=server_config.get("args", []),
            command=server_config.get("command"),
        )
        timeout_value = server_config.get("timeout")
        timeout_seconds = timeout_value if timeout_value is not None else 60 * 5
        return MCPTools(
            transport="stdio",
            server_params=server_params,
            timeout_seconds=timeout_seconds,
        )

    async def cleanup_tools(self) -> None:
        """
        Clean up all connected MCP tools
        """
        logger.info("Cleaning up MCP tools")
        for tools in self.connected_tools:
            try:
                if hasattr(tools, "disconnect"):
                    await tools.disconnect()
            except Exception as e:
                logger.warning(f"[MCP_DISCONNECT_FAIL] {type(e).__name__}: {str(e)}")
                # Add thinking step for MCP tools disconnection failure
                self.add_thinking_step_by_key(
                    title_key="thinking.mcp_init_fail",
                    report_immediately=False,
                    details={
                        "error_message": f"Failed to disconnect MCP tools. \nerror message: {str(e)}. \ntools: {json.dumps(tools, ensure_ascii=False)}"
                    },
                )

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

    def add_thinking_step_by_key(
        self,
        title_key: str,
        report_immediately: bool = True,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Add a thinking step using i18n key

        Args:
            title_key: i18n key for step title
            report_immediately: Whether to report this thinking step immediately (default True)
            details: Additional details for the thinking step (optional)
        """
        if self.thinking_manager:
            self.thinking_manager.add_thinking_step_by_key(
                title_key=title_key,
                report_immediately=report_immediately,
                details=details,
            )
