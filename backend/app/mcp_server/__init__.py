# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend MCP Server module.

This module provides a unified MCP Server for Wegent Backend with two endpoints:
- /mcp/system - System-level tools (silent_exit) automatically injected into all tasks
- /mcp/knowledge - Knowledge base tools available via Skill configuration

The MCP Server runs as part of the Backend FastAPI application and uses
FastMCP with HTTP Streamable transport.
"""

from .auth import get_user_from_task_token, verify_task_token
from .server import create_mcp_router, get_mcp_system_config

__all__ = [
    "create_mcp_router",
    "get_mcp_system_config",
    "verify_task_token",
    "get_user_from_task_token",
]
