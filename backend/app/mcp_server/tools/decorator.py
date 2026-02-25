# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tool decorator for independent tool functions.

This decorator is designed for standalone MCP tool functions in the tools layer,
NOT for FastAPI endpoints. It provides:

1. Automatic tool registration with custom name/description
2. Parameter override/filtering capabilities
3. Automatic token_info injection from MCP context
4. JSON serialization of results

Usage:
    from app.mcp_server.tools.decorator import mcp_tool

    @mcp_tool(
        name="list_knowledge_bases",
        description="List all accessible knowledge bases",
        server="knowledge",
        exclude_params=["token_info"],  # Hidden from MCP schema
    )
    def list_knowledge_bases(
        token_info: TaskTokenInfo,  # Auto-injected
        scope: str = "all",
        group_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        ...
"""

import inspect
import json
import logging
import re
from functools import wraps
from typing import Any, Callable, Dict, List, Optional, Type, Union

from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Global registry for tools decorated with @mcp_tool
_tools_registry: Dict[str, Dict[str, Any]] = {}


def _to_snake_case(name: str) -> str:
    """Convert CamelCase or mixed case to snake_case."""
    s1 = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub("([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def _extract_first_docstring_line(doc: Optional[str]) -> str:
    """Extract first non-empty line from docstring."""
    if not doc:
        return ""
    lines = doc.strip().split("\n")
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith(":"):
            return stripped
    return ""


def _python_type_to_json_schema(py_type: Any) -> Dict[str, Any]:
    """Convert Python type annotation to JSON schema."""
    # Handle None/NoneType
    if py_type is None or py_type is type(None):
        return {"type": "null"}

    # Handle basic types
    type_map = {
        str: {"type": "string"},
        int: {"type": "integer"},
        float: {"type": "number"},
        bool: {"type": "boolean"},
        list: {"type": "array"},
        dict: {"type": "object"},
    }

    if py_type in type_map:
        return type_map[py_type]

    # Handle typing module types
    origin = getattr(py_type, "__origin__", None)

    # Optional[X] = Union[X, None]
    if origin is Union:
        args = getattr(py_type, "__args__", ())
        # Filter out NoneType
        non_none_args = [a for a in args if a is not type(None)]
        if len(non_none_args) == 1:
            return _python_type_to_json_schema(non_none_args[0])
        # Multiple types - return first non-None
        if non_none_args:
            return _python_type_to_json_schema(non_none_args[0])
        return {"type": "string"}

    # List[X]
    if origin is list:
        args = getattr(py_type, "__args__", ())
        if args:
            return {"type": "array", "items": _python_type_to_json_schema(args[0])}
        return {"type": "array"}

    # Dict[K, V]
    if origin is dict:
        return {"type": "object"}

    # Pydantic models
    if isinstance(py_type, type) and issubclass(py_type, BaseModel):
        return {"type": "object"}

    # Default to string for unknown types
    return {"type": "string"}


def _extract_parameters_from_signature(
    func: Callable,
    exclude_params: List[str],
    param_descriptions: Dict[str, str],
    param_renames: Dict[str, str],
) -> List[Dict[str, Any]]:
    """Extract MCP parameter definitions from function signature.

    Args:
        func: Function to extract parameters from
        exclude_params: Parameters to exclude from MCP schema
        param_descriptions: Custom descriptions for parameters
        param_renames: Rename mapping (original_name -> mcp_name)

    Returns:
        List of parameter definitions for MCP schema
    """
    sig = inspect.signature(func)
    params = []

    for name, param in sig.parameters.items():
        # Skip excluded parameters
        if name in exclude_params:
            continue

        # Get MCP name (may be renamed)
        mcp_name = param_renames.get(name, name)

        # Determine type
        if param.annotation != inspect.Parameter.empty:
            schema = _python_type_to_json_schema(param.annotation)
        else:
            schema = {"type": "string"}

        # Determine if required
        has_default = param.default != inspect.Parameter.empty
        required = not has_default

        # Get description
        description = param_descriptions.get(name, "")

        param_def = {
            "name": mcp_name,
            "type": schema.get("type", "string"),
            "description": description,
            "required": required,
        }

        # Add default if present
        if has_default and param.default is not None:
            param_def["default"] = param.default

        params.append(param_def)

    return params


def mcp_tool(
    name: Optional[str] = None,
    description: Optional[str] = None,
    server: str = "knowledge",
    exclude_params: Optional[List[str]] = None,
    param_descriptions: Optional[Dict[str, str]] = None,
    param_renames: Optional[Dict[str, str]] = None,
) -> Callable:
    """Decorator to mark a function as an MCP tool.

    This decorator registers standalone tool functions for MCP exposure.
    It automatically handles:
    - Parameter schema extraction (excluding specified params)
    - token_info injection from MCP context
    - Result serialization to JSON

    Args:
        name: Tool name for MCP. Defaults to function name in snake_case.
        description: Tool description for LLM. Defaults to first docstring line.
        server: Target MCP server name ("knowledge", "system", etc.)
        exclude_params: Parameters to hide from MCP schema (e.g., ["token_info"])
        param_descriptions: Custom descriptions for parameters
        param_renames: Rename mapping for parameters (original -> mcp_name)

    Returns:
        Decorated function with _mcp_tool_info attribute

    Example:
        @mcp_tool(
            name="list_knowledge_bases",
            description="List all accessible knowledge bases",
            server="knowledge",
            exclude_params=["token_info"],
            param_descriptions={"scope": "Filter scope: all, personal, or group"},
        )
        def list_knowledge_bases(
            token_info: TaskTokenInfo,
            scope: str = "all",
            group_name: Optional[str] = None,
        ) -> Dict[str, Any]:
            ...
    """
    exclude_params = exclude_params or []
    param_descriptions = param_descriptions or {}
    param_renames = param_renames or {}

    # Always exclude token_info by default (it's injected from MCP context)
    if "token_info" not in exclude_params:
        exclude_params = ["token_info"] + list(exclude_params)

    def decorator(func: Callable) -> Callable:
        tool_name = name or _to_snake_case(func.__name__)
        tool_description = description or _extract_first_docstring_line(func.__doc__)

        # Extract parameters
        parameters = _extract_parameters_from_signature(
            func=func,
            exclude_params=exclude_params,
            param_descriptions=param_descriptions,
            param_renames=param_renames,
        )

        # Build tool info
        tool_info = {
            "func": func,
            "name": tool_name,
            "description": tool_description,
            "server": server,
            "parameters": parameters,
            "exclude_params": exclude_params,
            "param_renames": param_renames,
        }

        # Register in global registry
        _tools_registry[tool_name] = tool_info

        # Attach tool info to function
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return func(*args, **kwargs)

        wrapper._mcp_tool_info = tool_info  # type: ignore
        return wrapper

    return decorator


def get_registered_mcp_tools(server: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
    """Get all registered MCP tools, optionally filtered by server.

    Args:
        server: Filter by server name. If None, returns all tools.

    Returns:
        Dictionary of tool_name -> tool_info
    """
    if server:
        return {k: v for k, v in _tools_registry.items() if v["server"] == server}
    return _tools_registry.copy()


def clear_tools_registry() -> None:
    """Clear the global tools registry. Useful for testing."""
    _tools_registry.clear()


def build_mcp_tools_dict(server: str) -> Dict[str, Dict[str, Any]]:
    """Build KNOWLEDGE_MCP_TOOLS-style dict from registered tools.

    This provides backward compatibility with the manual registration approach.

    Args:
        server: Server name to filter

    Returns:
        Dictionary compatible with KNOWLEDGE_MCP_TOOLS format
    """
    tools = get_registered_mcp_tools(server=server)
    return {
        name: {
            "func": info["func"],
            "name": info["name"],
            "description": info["description"],
            "server": info["server"],
        }
        for name, info in tools.items()
    }
