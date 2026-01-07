# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP (Model Context Protocol) integration using langchain-mcp-adapters SDK.

Usage:
    async with MCPClient(config) as client:
        tools = client.get_tools()

    # Or use the loader function
    client = await load_mcp_tools(task_id, bot_name, bot_namespace)
"""

from .client import MCPClient, build_connections
from .loader import load_mcp_tools

__all__ = ["MCPClient", "build_connections", "load_mcp_tools"]
