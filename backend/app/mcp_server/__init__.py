# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend MCP Server module.

This module provides a unified MCP Server for Wegent Backend with two endpoints:
- /mcp/system - System-level tools (silent_exit) automatically injected into all tasks
- /mcp/knowledge - Knowledge MCP module root
  - /mcp/knowledge/sse - Knowledge MCP streamable HTTP transport endpoint
New MCP servers should follow /mcp/<name>/sse for streamable HTTP transport.

The MCP Server runs as part of the Backend FastAPI application and uses
FastMCP with HTTP Streamable transport.

The knowledge MCP server uses a decorator-based auto-registration system:
- Standalone tool functions marked with @mcp_tool decorator are automatically registered
- Parameters are extracted from function signatures
- Tools use KnowledgeOrchestrator service layer for business logic
- This eliminates code duplication and avoids FastAPI dependency injection complexity
"""

from .auth import get_user_from_task_token, verify_task_token
from .context import (
    MCPRequestContext,
    get_mcp_context,
    get_token_info_from_context,
    reset_mcp_context,
    set_mcp_context,
)
from .server import (
    create_mcp_router,
    ensure_knowledge_tools_registered,
    get_mcp_system_config,
    register_mcp_apps,
)
from .tools.decorator import (
    clear_tools_registry,
    get_registered_mcp_tools,
    mcp_tool,
)

__all__ = [
    # Server functions
    "create_mcp_router",
    "get_mcp_system_config",
    "register_mcp_apps",
    "ensure_knowledge_tools_registered",
    # Auth functions
    "verify_task_token",
    "get_user_from_task_token",
    # Decorator (from tools.decorator)
    "mcp_tool",
    "get_registered_mcp_tools",
    "clear_tools_registry",
    # Context
    "MCPRequestContext",
    "get_mcp_context",
    "set_mcp_context",
    "reset_mcp_context",
    "get_token_info_from_context",
]
