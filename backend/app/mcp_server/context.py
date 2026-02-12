# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP request context management.

This module provides context variables for passing MCP request information
(such as task tokens and user info) to FastAPI endpoints when invoked via MCP.
"""

import contextvars
from dataclasses import dataclass
from typing import Optional

from app.mcp_server.auth import TaskTokenInfo

# MCP request context - thread-safe storage for request-scoped data
_mcp_context: contextvars.ContextVar[Optional["MCPRequestContext"]] = (
    contextvars.ContextVar("_mcp_context", default=None)
)


@dataclass
class MCPRequestContext:
    """Context for MCP tool invocations.

    This context is set before invoking a tool and reset after completion.
    It provides access to authentication and request metadata.

    Attributes:
        token_info: Validated task token containing user and task identifiers
        tool_name: Name of the MCP tool being invoked
        server_name: Name of the MCP server handling the request
    """

    token_info: TaskTokenInfo
    tool_name: str
    server_name: str


def get_mcp_context() -> Optional[MCPRequestContext]:
    """Get current MCP request context.

    Returns:
        MCPRequestContext if in MCP invocation context, None otherwise.
    """
    return _mcp_context.get()


def set_mcp_context(ctx: MCPRequestContext) -> contextvars.Token:
    """Set MCP request context for current execution.

    Args:
        ctx: MCP request context to set

    Returns:
        Token for resetting the context later
    """
    return _mcp_context.set(ctx)


def reset_mcp_context(token: contextvars.Token) -> None:
    """Reset MCP request context using the token from set_mcp_context.

    Args:
        token: Token returned by set_mcp_context
    """
    _mcp_context.reset(token)


def get_token_info_from_context() -> Optional[TaskTokenInfo]:
    """Convenience function to get TaskTokenInfo from MCP context.

    Returns:
        TaskTokenInfo if in MCP context and authenticated, None otherwise.
    """
    ctx = get_mcp_context()
    if ctx:
        return ctx.token_info
    return None
