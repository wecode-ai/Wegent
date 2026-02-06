# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tool decorator for marking FastAPI endpoints as MCP tools.

This module provides the @mcp_tool decorator that allows FastAPI endpoints
to be automatically registered as MCP tools, eliminating code duplication
between REST API and MCP server implementations.

Usage:
    from app.mcp_server.decorator import mcp_tool

    @router.get("/knowledge-bases", response_model=KnowledgeBaseListResponse)
    @mcp_tool(name="list_knowledge_bases", server="knowledge")
    def list_knowledge_bases(...):
        '''List all accessible knowledge bases.'''
        ...
"""

import re
from functools import wraps
from typing import Any, Callable, Dict, List, Optional, Type

from pydantic import BaseModel

# Global registry for all marked endpoints
_mcp_tool_registry: List[Dict[str, Any]] = []


def _to_snake_case(name: str) -> str:
    """Convert CamelCase or mixed case to snake_case.

    Args:
        name: Input string in any case format

    Returns:
        String converted to snake_case
    """
    # Insert underscore before uppercase letters and convert to lowercase
    s1 = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub("([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def mcp_tool(
    name: Optional[str] = None,
    description: Optional[str] = None,
    server: str = "knowledge",
    response_model: Optional[Type[BaseModel]] = None,
) -> Callable:
    """Decorator to mark a FastAPI endpoint as an MCP tool.

    This decorator registers the endpoint for automatic exposure as an MCP tool.
    The endpoint can then be discovered and registered by the MCP server at startup.

    Args:
        name: Tool name for MCP. Defaults to function name converted to snake_case.
        description: Tool description for LLM. Defaults to function's first docstring line.
        server: Target MCP server name. One of "knowledge", "system", or custom name.
        response_model: Pydantic model for response schema inference. If not specified,
            will try to infer from FastAPI's response_model or function return type.

    Returns:
        Decorated function with _mcp_tool_info attribute containing registration metadata.

    Example:
        @router.get("/knowledge-bases", response_model=KnowledgeBaseListResponse)
        @mcp_tool(name="list_knowledge_bases", server="knowledge")
        def list_knowledge_bases(
            scope: str = Query(default="all"),
            current_user: User = Depends(security.get_current_user),
            db: Session = Depends(get_db),
        ):
            '''List all knowledge bases accessible to the current user.'''
            ...

        # With explicit response_model:
        @router.get("/knowledge-bases")
        @mcp_tool(
            name="list_knowledge_bases",
            server="knowledge",
            response_model=KnowledgeBaseListResponse,
        )
        def list_knowledge_bases(...):
            ...
    """

    def decorator(func: Callable) -> Callable:
        # Extract function metadata for registration
        func_doc = func.__doc__ or ""
        first_line = func_doc.strip().split("\n")[0] if func_doc else ""

        tool_info: Dict[str, Any] = {
            "func": func,
            "name": name or _to_snake_case(func.__name__),
            "description": description or first_line,
            "server": server,
            "module": func.__module__,
            "response_model": response_model,
        }

        # Register in global registry
        _mcp_tool_registry.append(tool_info)

        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return func(*args, **kwargs)

        # Mark function with tool info for introspection
        wrapper._mcp_tool_info = tool_info  # type: ignore
        return wrapper

    return decorator


def get_registered_tools(server: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get all registered MCP tools, optionally filtered by server.

    Args:
        server: Filter by target server name. If None, returns all tools.

    Returns:
        List of tool registration dictionaries containing func, name, description,
        server, module, and response_model.
    """
    if server:
        return [t for t in _mcp_tool_registry if t["server"] == server]
    return _mcp_tool_registry.copy()


def clear_registry() -> None:
    """Clear the global tool registry. Useful for testing."""
    _mcp_tool_registry.clear()
