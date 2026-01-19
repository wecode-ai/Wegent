# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Built-in MCP Server for interactive messaging.

This module provides MCP tools for AI agents to send interactive messages
to users, including text messages, forms, confirmations, and selections.
"""

from app.mcp.server import router as mcp_router

__all__ = ["mcp_router"]
