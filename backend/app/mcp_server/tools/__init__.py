# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP Server tools module.

Contains tools for:
- System MCP (silent_exit)

Note: Knowledge MCP tools have been migrated to use the decorator-based
auto-registration system. See @mcp_tool decorator in app.mcp_server.decorator.
Knowledge tools are now defined directly on FastAPI endpoints in
app.api.endpoints.knowledge and registered automatically.
"""

from .silent_exit import silent_exit

__all__ = [
    "silent_exit",
]
