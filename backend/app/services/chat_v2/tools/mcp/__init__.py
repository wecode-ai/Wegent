# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP (Model Context Protocol) integration using langchain-mcp-adapters SDK.

Usage:
    async with MCPClient(config) as client:
        tools = client.get_tools()
"""

from .client import MCPClient, build_connections

__all__ = ["MCPClient", "build_connections"]
