# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend MCP Server module.

This module provides a unified MCP Server for Wegent Backend with two endpoints:
- /mcp/system - System-level tools (silent_exit) automatically injected into all tasks
- /mcp/knowledge - Knowledge base tools available via Skill configuration

The MCP Server runs as part of the Backend FastAPI application and uses
FastMCP with HTTP Streamable transport.

The knowledge MCP server uses a decorator-based auto-registration system:
- FastAPI endpoints marked with @mcp_tool decorator are automatically registered
- Parameters and response schemas are extracted from endpoint signatures
- This eliminates code duplication between REST API and MCP implementations
"""

from .auth import get_user_from_task_token, verify_task_token
from .context import (
    MCPRequestContext,
    get_mcp_context,
    get_token_info_from_context,
    reset_mcp_context,
    set_mcp_context,
)
from .decorator import clear_registry, get_registered_tools, mcp_tool
from .server import (
    create_mcp_router,
    ensure_knowledge_tools_registered,
    get_mcp_system_config,
)

__all__ = [
    # Server functions
    "create_mcp_router",
    "get_mcp_system_config",
    "ensure_knowledge_tools_registered",
    # Auth functions
    "verify_task_token",
    "get_user_from_task_token",
    # Decorator
    "mcp_tool",
    "get_registered_tools",
    "clear_registry",
    # Context
    "MCPRequestContext",
    "get_mcp_context",
    "set_mcp_context",
    "reset_mcp_context",
    "get_token_info_from_context",
]
