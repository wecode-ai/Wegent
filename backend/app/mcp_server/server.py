# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wegent Backend MCP Server.

This module provides a unified MCP Server for Wegent Backend with two endpoints:
- /mcp/system - System-level tools (silent_exit) automatically injected into all tasks
- /mcp/knowledge - Knowledge base tools available via Skill configuration

The MCP Server uses FastMCP with HTTP Streamable transport and integrates
with the existing FastAPI application.

The knowledge MCP server uses a decorator-based auto-registration system:
- FastAPI endpoints marked with @mcp_tool decorator are automatically registered
- Parameters and response schemas are extracted from endpoint signatures
- This eliminates code duplication between REST API and MCP implementations
"""

import contextvars
import json
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Request
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from app.core.config import settings
from app.mcp_server.auth import (
    TaskTokenInfo,
    extract_token_from_header,
    verify_task_token,
)
from app.mcp_server.context import (
    MCPRequestContext,
    reset_mcp_context,
    set_mcp_context,
)

logger = logging.getLogger(__name__)

# ============== System MCP Server ==============
# Provides system-level tools like silent_exit
# Automatically injected into all subscription tasks

system_mcp_server = FastMCP(
    "wegent-system-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
)

# Store for system MCP request context (using ContextVar for thread-safe concurrent request handling)
_system_request_token_info: contextvars.ContextVar[Optional[TaskTokenInfo]] = (
    contextvars.ContextVar("_system_request_token_info", default=None)
)


def _get_system_token_info_from_context() -> Optional[TaskTokenInfo]:
    """Get token info from system MCP request context."""
    return _system_request_token_info.get()


@system_mcp_server.tool()
def silent_exit(reason: str = "") -> str:
    """Call this tool when execution result doesn't require user attention.

    For example: regular status checks with no anomalies, routine data collection
    with expected results, or monitoring tasks where everything is normal.
    This will end the execution immediately and hide it from the timeline by default.

    Args:
        reason: Optional reason for silent exit (for logging only, not shown to user)

    Returns:
        JSON string with silent exit marker
    """
    from app.mcp_server.tools.silent_exit import silent_exit as impl_silent_exit

    # Get token info from request context to update subtask in database
    token_info = _get_system_token_info_from_context()
    logger.info(
        f"[MCP:System] silent_exit called with reason: {reason}, "
        f"token_info: {token_info.subtask_id if token_info else None}"
    )
    return impl_silent_exit(reason=reason, token_info=token_info)


# ============== Knowledge MCP Server ==============
# Provides knowledge base management tools
# Available via Skill configuration
# Uses decorator-based auto-registration from @mcp_tool decorated endpoints

knowledge_mcp_server = FastMCP(
    "wegent-knowledge-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
)


# Flag to track if tools have been registered
_knowledge_tools_registered = False


def _register_knowledge_tools() -> None:
    """Register knowledge tools from @mcp_tool decorated endpoints.

    This function imports the knowledge endpoint module to trigger decorator
    registration, then registers all collected tools to the knowledge MCP server.
    """
    global _knowledge_tools_registered
    if _knowledge_tools_registered:
        return

    # Import endpoint modules to trigger @mcp_tool decorator registration
    # The decorators will add tools to the global registry
    from app.api.endpoints import knowledge  # noqa: F401
    from app.mcp_server.tool_registry import register_tools_to_server

    # Register all collected tools to the knowledge server
    count = register_tools_to_server(knowledge_mcp_server, "knowledge")
    logger.info(f"[MCP:Knowledge] Registered {count} tools from decorated endpoints")

    _knowledge_tools_registered = True


def ensure_knowledge_tools_registered() -> None:
    """Ensure knowledge MCP tools are registered.

    This should be called during application startup to register
    all @mcp_tool decorated endpoints as MCP tools.
    """
    _register_knowledge_tools()


# ============== Starlette App Factory ==============


def _create_system_mcp_app() -> Starlette:
    """Create Starlette app for system MCP server.

    Note: The session_manager.run() is managed by FastAPI's lifespan in main.py,
    not by this Starlette app's lifespan. This is required because FastAPI's
    app.mount() does not automatically run the mounted app's lifespan.
    """

    async def health_check(request: Request):
        return JSONResponse({"status": "healthy", "service": "wegent-system-mcp"})

    async def system_auth_middleware(request: Request, call_next):
        """Middleware to extract and validate task token for system MCP."""
        auth_header = request.headers.get("authorization", "")
        token = extract_token_from_header(auth_header)

        token_info: Optional[TaskTokenInfo] = None
        if token:
            token_info = verify_task_token(token)
            if token_info:
                logger.debug(
                    f"[MCP:System] Authenticated: task={token_info.task_id}, "
                    f"subtask={token_info.subtask_id}, user={token_info.user_name}"
                )
            else:
                logger.warning("[MCP:System] Invalid task token")

        # Set token info in context var for the duration of this request
        ctx_token = _system_request_token_info.set(token_info)
        try:
            response = await call_next(request)
            return response
        finally:
            # Reset context var after request completes
            _system_request_token_info.reset(ctx_token)

    # No lifespan here - session_manager is managed by FastAPI's lifespan
    # Create base app
    base_app = Starlette(
        debug=False,
        routes=[
            Route("/health", health_check, methods=["GET"]),
            Mount("/", app=system_mcp_server.streamable_http_app()),
        ],
    )

    # Add auth middleware to extract task token
    from starlette.middleware.base import BaseHTTPMiddleware

    class SystemAuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            return await system_auth_middleware(request, call_next)

    base_app.add_middleware(SystemAuthMiddleware)

    return base_app


def _create_knowledge_mcp_app() -> Starlette:
    """Create Starlette app for knowledge MCP server.

    Note: The session_manager.run() is managed by FastAPI's lifespan in main.py,
    not by this Starlette app's lifespan. This is required because FastAPI's
    app.mount() does not automatically run the mounted app's lifespan.
    """

    # Ensure knowledge tools are registered before creating the app
    ensure_knowledge_tools_registered()

    async def health_check(request: Request):
        return JSONResponse({"status": "healthy", "service": "wegent-knowledge-mcp"})

    async def auth_middleware(request: Request, call_next):
        """Middleware to extract and validate task token.

        This middleware sets both the legacy _request_token_info and the new
        MCPRequestContext for backward compatibility during migration.
        """
        auth_header = request.headers.get("authorization", "")
        token_str = extract_token_from_header(auth_header)

        token_info: Optional[TaskTokenInfo] = None
        mcp_ctx_token = None

        if token_str:
            token_info = verify_task_token(token_str)
            if token_info:
                logger.debug(
                    f"[MCP:Knowledge] Authenticated user: {token_info.user_name}"
                )
                # Set new MCPRequestContext for decorator-based tools
                mcp_ctx = MCPRequestContext(
                    token_info=token_info,
                    tool_name="",  # Will be set by tool invocation
                    server_name="knowledge",
                )
                mcp_ctx_token = set_mcp_context(mcp_ctx)
            else:
                logger.warning("[MCP:Knowledge] Invalid task token")

        try:
            response = await call_next(request)
            return response
        finally:
            # Reset context after request completes
            if mcp_ctx_token:
                reset_mcp_context(mcp_ctx_token)

    # No lifespan here - session_manager is managed by FastAPI's lifespan
    # Create base app
    base_app = Starlette(
        debug=False,
        routes=[
            Route("/health", health_check, methods=["GET"]),
            Mount("/", app=knowledge_mcp_server.streamable_http_app()),
        ],
    )

    # Add auth middleware
    from starlette.middleware.base import BaseHTTPMiddleware

    class AuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            return await auth_middleware(request, call_next)

    base_app.add_middleware(AuthMiddleware)

    return base_app


# ============== FastAPI Router Integration ==============


def create_mcp_router() -> APIRouter:
    """Create FastAPI router that mounts MCP servers.

    Returns:
        APIRouter with MCP server endpoints mounted
    """
    router = APIRouter(tags=["MCP"])

    # Mount system MCP at /mcp/system
    system_app = _create_system_mcp_app()

    # Mount knowledge MCP at /mcp/knowledge
    knowledge_app = _create_knowledge_mcp_app()

    # Use Starlette mounting through FastAPI
    from fastapi import FastAPI

    # Create sub-applications
    @router.get("/mcp/system/health")
    async def system_health():
        return {"status": "healthy", "service": "wegent-system-mcp"}

    @router.get("/mcp/knowledge/health")
    async def knowledge_health():
        return {"status": "healthy", "service": "wegent-knowledge-mcp"}

    return router, system_app, knowledge_app


def get_mcp_system_config(backend_url: str, task_token: str) -> Dict[str, Any]:
    """Get system MCP server configuration for task injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        task_token: Task token for authentication

    Returns:
        MCP server configuration dictionary
    """
    return {
        "wegent-system": {
            "type": "streamable-http",
            "url": f"{backend_url}/mcp/system",
            "headers": {
                "Authorization": f"Bearer {task_token}",
            },
            "timeout": 60,
        }
    }


def get_mcp_knowledge_config(backend_url: str, task_token: str) -> Dict[str, Any]:
    """Get knowledge MCP server configuration for Skill injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        task_token: Task token for authentication (uses placeholder for Skill)

    Returns:
        MCP server configuration dictionary
    """
    return {
        "wegent-knowledge": {
            "type": "streamable-http",
            "url": f"{backend_url}/mcp/knowledge",
            "headers": {
                "Authorization": f"Bearer {task_token}",
            },
            "timeout": 300,  # 5 minutes for document operations
        }
    }
