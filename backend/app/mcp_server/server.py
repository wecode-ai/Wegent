# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wegent Backend MCP Server.

This module provides a unified MCP Server for Wegent Backend with two endpoints:
- /mcp/system - System-level tools (silent_exit) automatically injected into all tasks
- /mcp/knowledge - Knowledge base tools available via Skill configuration

The MCP Server uses FastMCP with HTTP Streamable transport and integrates
with the existing FastAPI application.
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

knowledge_mcp_server = FastMCP(
    "wegent-knowledge-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
)


# Store for request context (using ContextVar for thread-safe concurrent request handling)
_request_token_info: contextvars.ContextVar[Optional[TaskTokenInfo]] = (
    contextvars.ContextVar("_request_token_info", default=None)
)


def _get_token_info_from_context() -> Optional[TaskTokenInfo]:
    """Get token info from request context."""
    return _request_token_info.get()


@knowledge_mcp_server.tool()
def list_knowledge_bases(
    scope: str = "all",
    group_name: str = "",
) -> str:
    """List all knowledge bases accessible to the current user.

    Args:
        scope: Scope filter - "personal", "group", or "all" (default)
        group_name: Group name when scope="group"

    Returns:
        JSON string with list of knowledge bases
    """
    from app.mcp_server.tools.knowledge import (
        list_knowledge_bases as impl_list_knowledge_bases,
    )

    token_info = _get_token_info_from_context()
    if not token_info:
        return json.dumps({"error": "Authentication required"})

    result = impl_list_knowledge_bases(
        token_info=token_info,
        scope=scope,
        group_name=group_name if group_name else None,
    )
    return json.dumps(result, ensure_ascii=False, default=str)


@knowledge_mcp_server.tool()
def list_documents(
    knowledge_base_id: int,
    status: str = "all",
) -> str:
    """List all documents in a knowledge base.

    Args:
        knowledge_base_id: Knowledge base ID
        status: Status filter - "enabled", "disabled", or "all" (default)

    Returns:
        JSON string with list of documents
    """
    from app.mcp_server.tools.knowledge import list_documents as impl_list_documents

    token_info = _get_token_info_from_context()
    if not token_info:
        return json.dumps({"error": "Authentication required"})

    result = impl_list_documents(
        token_info=token_info,
        knowledge_base_id=knowledge_base_id,
        status=status,
    )
    return json.dumps(result, ensure_ascii=False, default=str)


@knowledge_mcp_server.tool()
def create_document(
    knowledge_base_id: int,
    name: str,
    source_type: str,
    content: str = "",
    file_base64: str = "",
    file_extension: str = "",
    url: str = "",
) -> str:
    """Create a new document in a knowledge base.

    Args:
        knowledge_base_id: Target knowledge base ID
        name: Document name
        source_type: Source type - "text", "file", or "web"
        content: Document content when source_type="text"
        file_base64: Base64 encoded file content when source_type="file"
        file_extension: File extension when source_type="file"
        url: URL to fetch when source_type="web"

    Returns:
        JSON string with created document info
    """
    from app.mcp_server.tools.knowledge import create_document as impl_create_document

    token_info = _get_token_info_from_context()
    if not token_info:
        return json.dumps({"error": "Authentication required"})

    result = impl_create_document(
        token_info=token_info,
        knowledge_base_id=knowledge_base_id,
        name=name,
        source_type=source_type,
        content=content if content else None,
        file_base64=file_base64 if file_base64 else None,
        file_extension=file_extension if file_extension else None,
        url=url if url else None,
    )
    return json.dumps(result, ensure_ascii=False, default=str)


@knowledge_mcp_server.tool()
def update_document(
    document_id: int,
    content: str,
    mode: str = "replace",
) -> str:
    """Update a document's content.

    Args:
        document_id: Document ID to update
        content: New content
        mode: Update mode - "replace" (default) or "append"

    Returns:
        JSON string with updated document info
    """
    from app.mcp_server.tools.knowledge import update_document as impl_update_document

    token_info = _get_token_info_from_context()
    if not token_info:
        return json.dumps({"error": "Authentication required"})

    result = impl_update_document(
        token_info=token_info,
        document_id=document_id,
        content=content,
        mode=mode,
    )
    return json.dumps(result, ensure_ascii=False, default=str)


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

    async def health_check(request: Request):
        return JSONResponse({"status": "healthy", "service": "wegent-knowledge-mcp"})

    async def auth_middleware(request: Request, call_next):
        """Middleware to extract and validate task token."""
        auth_header = request.headers.get("authorization", "")
        token = extract_token_from_header(auth_header)

        token_info: Optional[TaskTokenInfo] = None
        if token:
            token_info = verify_task_token(token)
            if token_info:
                logger.debug(
                    f"[MCP:Knowledge] Authenticated user: {token_info.user_name}"
                )
            else:
                logger.warning("[MCP:Knowledge] Invalid task token")

        # Set token info in context var for the duration of this request
        token = _request_token_info.set(token_info)
        try:
            response = await call_next(request)
            return response
        finally:
            # Reset context var after request completes
            _request_token_info.reset(token)

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
    from starlette.middleware import Middleware
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
