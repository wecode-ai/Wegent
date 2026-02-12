# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tool registry for automatic tool registration.

This module provides functions to automatically register MCP tools from
standalone tool functions marked with @mcp_tool decorator.

The @mcp_tool decorator is defined in app.mcp_server.tools.decorator and is
designed for independent tool functions that use KnowledgeOrchestrator
service layer, avoiding the complexity of FastAPI dependency injection.
"""

import inspect
import json
import logging
from typing import Any, Callable, Dict, List, Optional

from mcp.server.fastmcp import FastMCP

from app.mcp_server.context import get_mcp_context
from app.mcp_server.schema_extractor import generate_tool_docstring
from app.mcp_server.tools.decorator import get_registered_mcp_tools

logger = logging.getLogger(__name__)


def register_tools_to_server(mcp_server: FastMCP, server_name: str) -> int:
    """Register all decorated tools to the MCP server.

    Collects tools from the standalone tool function decorator system
    (app.mcp_server.tools.decorator) and registers them to FastMCP.

    Args:
        mcp_server: FastMCP server instance
        server_name: Server name to filter tools ("knowledge", "system")

    Returns:
        Number of tools registered
    """
    registered_count = 0

    # Register tools from standalone tool function decorators
    standalone_tools = get_registered_mcp_tools(server=server_name)
    for tool_name, tool_info in standalone_tools.items():
        try:
            _register_tool(mcp_server, tool_info, server_name)
            logger.info(f"[MCP] Registered tool: {tool_name} -> {server_name}")
            registered_count += 1
        except Exception as e:
            logger.error(
                f"[MCP] Failed to register tool {tool_name}: {e}",
                exc_info=True,
            )

    return registered_count


def _register_tool(
    mcp_server: FastMCP, tool_info: Dict[str, Any], server_name: str
) -> None:
    """Register a standalone MCP tool function to MCP server.

    This handles tools from app.mcp_server.tools.decorator which have
    pre-computed parameters and use token_info injection.

    Args:
        mcp_server: FastMCP server instance
        tool_info: Tool registration info from decorator
        server_name: Target server name
    """
    func = tool_info["func"]
    tool_name = tool_info["name"]
    tool_description = tool_info["description"]
    parameters = tool_info["parameters"]

    # Generate full docstring
    full_docstring = generate_tool_docstring(
        name=tool_name,
        description=tool_description,
        parameters=parameters,
        response_schema={"type": "object"},  # Default response schema
    )

    # Get parameter names for filtering call kwargs
    mcp_param_names = [p["name"] for p in parameters]

    # Create wrapper that handles token_info injection
    def tool_wrapper(**kwargs: Any) -> str:
        ctx = get_mcp_context()
        if not ctx or not ctx.token_info:
            return json.dumps({"error": "Authentication required"})

        try:
            # Build call kwargs with only valid MCP parameters
            call_kwargs = {k: v for k, v in kwargs.items() if k in mcp_param_names}

            # Inject token_info
            call_kwargs["token_info"] = ctx.token_info

            # Call original function
            result = func(**call_kwargs)

            # Serialize result
            return _serialize_result(result)

        except Exception as e:
            logger.error(
                f"[MCP:{server_name}] Tool {tool_name} failed: {e}",
                exc_info=True,
            )
            return json.dumps({"error": str(e)})

    # Set function metadata for FastMCP
    tool_wrapper.__name__ = tool_name
    tool_wrapper.__doc__ = full_docstring

    # Set function signature for FastMCP parameter inference
    _set_function_signature(tool_wrapper, parameters)

    # Register to MCP server
    mcp_server.tool()(tool_wrapper)


def _serialize_result(result: Any) -> str:
    """Serialize tool result to JSON string.

    Args:
        result: Result from tool function

    Returns:
        JSON string representation
    """
    if result is None:
        return json.dumps({"success": True})

    if isinstance(result, str):
        return result

    if hasattr(result, "model_dump"):
        return json.dumps(result.model_dump(), ensure_ascii=False, default=str)
    elif hasattr(result, "dict"):
        return json.dumps(result.dict(), ensure_ascii=False, default=str)
    else:
        return json.dumps(result, ensure_ascii=False, default=str)


def _set_function_signature(func: Callable, params: List[Dict[str, Any]]) -> None:
    """Set function signature for FastMCP parameter inference.

    Args:
        func: Function to modify
        params: List of parameter definitions
    """
    new_params = []
    for param in params:
        param_name = param["name"]
        param_type = _json_type_to_python_type(param["type"])
        default = param.get("default", inspect.Parameter.empty)

        # Handle optional parameters
        if not param.get("required", True) and default is inspect.Parameter.empty:
            default = None
            param_type = Optional[param_type]

        new_params.append(
            inspect.Parameter(
                name=param_name,
                kind=inspect.Parameter.KEYWORD_ONLY,
                default=default,
                annotation=param_type,
            )
        )

    # Set signature with return type
    func.__signature__ = inspect.Signature(
        parameters=new_params,
        return_annotation=str,
    )


def _json_type_to_python_type(json_type: str) -> type:
    """Convert JSON schema type back to Python type.

    Args:
        json_type: JSON schema type string

    Returns:
        Python type
    """
    type_map = {
        "string": str,
        "integer": int,
        "number": float,
        "boolean": bool,
        "array": list,
        "object": dict,
    }
    return type_map.get(json_type, str)
