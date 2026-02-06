# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tool registry for automatic endpoint registration.

This module provides functions to automatically register FastAPI endpoints
marked with @mcp_tool decorator as MCP tools on the FastMCP server.
"""

import asyncio
import inspect
import json
import logging
from typing import Any, Callable, Dict, List, Optional

from mcp.server.fastmcp import FastMCP

from app.mcp_server.context import (
    MCPRequestContext,
    get_mcp_context,
    reset_mcp_context,
    set_mcp_context,
)
from app.mcp_server.decorator import get_registered_tools
from app.mcp_server.schema_extractor import (
    extract_response_schema,
    extract_tool_parameters,
    generate_tool_docstring,
)

logger = logging.getLogger(__name__)


def register_tools_to_server(mcp_server: FastMCP, server_name: str) -> int:
    """Register all decorated endpoints to the MCP server.

    Args:
        mcp_server: FastMCP server instance
        server_name: Server name to filter tools ("knowledge", "system")

    Returns:
        Number of tools registered
    """
    tools = get_registered_tools(server=server_name)
    registered_count = 0

    for tool_info in tools:
        try:
            _register_single_tool(mcp_server, tool_info, server_name)
            logger.info(f"[MCP] Registered tool: {tool_info['name']} -> {server_name}")
            registered_count += 1
        except Exception as e:
            logger.error(
                f"[MCP] Failed to register tool {tool_info['name']}: {e}",
                exc_info=True,
            )

    return registered_count


def _register_single_tool(
    mcp_server: FastMCP, tool_info: Dict[str, Any], server_name: str
) -> None:
    """Register a single tool to MCP server.

    Args:
        mcp_server: FastMCP server instance
        tool_info: Tool registration info from decorator
        server_name: Target server name
    """
    func = tool_info["func"]
    tool_name = tool_info["name"]
    base_description = tool_info["description"]
    explicit_response_model = tool_info.get("response_model")

    # Extract parameters and response schema
    params = extract_tool_parameters(func)
    response_schema = extract_response_schema(func, explicit_response_model)

    # Generate comprehensive docstring
    full_docstring = generate_tool_docstring(
        name=tool_name,
        description=base_description,
        parameters=params,
        response_schema=response_schema,
    )

    # Get parameter names for filtering call kwargs
    mcp_param_names = [p["name"] for p in params]

    # Check if function is async
    is_async = asyncio.iscoroutinefunction(func)

    # Create wrapper function for MCP tool
    wrapper = _create_tool_wrapper(
        original_func=func,
        param_names=mcp_param_names,
        tool_name=tool_name,
        server_name=server_name,
        is_async=is_async,
    )

    # Set function metadata for FastMCP
    wrapper.__name__ = tool_name
    wrapper.__doc__ = full_docstring

    # Set function signature for FastMCP parameter inference
    _set_function_signature(wrapper, params)

    # Register to MCP server
    mcp_server.tool()(wrapper)


def _create_tool_wrapper(
    original_func: Callable,
    param_names: List[str],
    tool_name: str,
    server_name: str,
    is_async: bool,
) -> Callable:
    """Create a wrapper function for MCP tool invocation.

    Args:
        original_func: Original FastAPI endpoint function
        param_names: List of MCP parameter names
        tool_name: Tool name for logging
        server_name: Server name for context
        is_async: Whether original function is async

    Returns:
        Wrapper function that handles MCP invocation
    """

    def sync_tool_wrapper(**kwargs: Any) -> str:
        return _invoke_endpoint(
            original_func=original_func,
            kwargs=kwargs,
            param_names=param_names,
            tool_name=tool_name,
            server_name=server_name,
            is_async=is_async,
        )

    return sync_tool_wrapper


def _invoke_endpoint(
    original_func: Callable,
    kwargs: Dict[str, Any],
    param_names: List[str],
    tool_name: str,
    server_name: str,
    is_async: bool,
) -> str:
    """Invoke the original endpoint with proper context.

    Args:
        original_func: Original FastAPI endpoint function
        kwargs: MCP tool call arguments
        param_names: List of valid parameter names
        tool_name: Tool name for logging
        server_name: Server name for context
        is_async: Whether original function is async

    Returns:
        JSON string with result or error
    """
    from app.db.session import SessionLocal
    from app.models.user import User

    ctx = get_mcp_context()
    if not ctx or not ctx.token_info:
        return json.dumps({"error": "Authentication required"})

    db = SessionLocal()
    try:
        # Get user object
        user = db.query(User).filter(User.id == ctx.token_info.user_id).first()
        if not user:
            return json.dumps({"error": "User not found"})

        # Build call kwargs with only valid MCP parameters
        call_kwargs = {k: v for k, v in kwargs.items() if k in param_names}

        # Inject FastAPI dependencies
        call_kwargs["db"] = db
        call_kwargs["current_user"] = user

        # Call original function
        if is_async:
            # Run async function in event loop
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(original_func(**call_kwargs))
            finally:
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.close()
        else:
            result = original_func(**call_kwargs)

        # Serialize result
        return _serialize_result(result)

    except Exception as e:
        logger.error(f"[MCP] Tool {tool_name} failed: {e}", exc_info=True)
        return json.dumps({"error": str(e)})
    finally:
        db.close()


def _serialize_result(result: Any) -> str:
    """Serialize endpoint result to JSON string.

    Args:
        result: Result from endpoint function

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
    from typing import Optional

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
