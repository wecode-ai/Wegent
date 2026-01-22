# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wegent MCP Server - HTTP-based MCP server for Wegent internal tools."""

from executor.mcp_servers.wegent.server import (
    create_wegent_mcp_app,
    start_wegent_mcp_server,
)

__all__ = ["create_wegent_mcp_app", "start_wegent_mcp_server"]
