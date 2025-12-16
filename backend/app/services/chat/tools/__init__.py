# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell Tools Module.

This module provides a unified tool system for Chat Shell:
- Tool: Base class for all tools
- ToolRegistry: Global registry for tool management
- Built-in tools: web search, etc.
- MCP tools: External MCP server integration
"""

from app.services.chat.tools.base import Tool, ToolRegistry
from app.services.chat.tools.builtin import get_web_search_tool
from app.services.chat.tools.mcp import (
    cleanup_mcp_session,
    get_mcp_session,
    is_mcp_enabled,
)

__all__ = [
    # Base
    "Tool",
    "ToolRegistry",
    # Built-in tools
    "get_web_search_tool",
    # MCP tools
    "get_mcp_session",
    "cleanup_mcp_session",
    "is_mcp_enabled",
]
