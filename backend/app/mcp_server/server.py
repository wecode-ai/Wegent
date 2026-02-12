# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wegent Backend MCP Server.

This module provides a unified MCP Server for Wegent Backend with two endpoints:
- /mcp/system - System-level tools (silent_exit) automatically injected into all tasks
- /mcp/knowledge - Knowledge MCP module root
  - /mcp/knowledge/sse - Knowledge MCP streamable HTTP transport endpoint
New MCP servers should follow /mcp/<name>/sse for streamable HTTP transport.

The MCP Server uses FastMCP with HTTP Streamable transport and integrates
with the existing FastAPI application.

The knowledge MCP server uses a decorator-based auto-registration system:
- FastAPI endpoints marked with @mcp_tool decorator are automatically registered
- Parameters and response schemas are extracted from endpoint signatures
- This eliminates code duplication between REST API and MCP implementations
"""

import contextvars
import logging
from dataclasses import dataclass, replace
from typing import Any, Dict, Optional

from fastapi import APIRouter, FastAPI, Request
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

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

MCP_TRANSPORT_METHODS = ["GET", "POST", "DELETE", "OPTIONS"]
SYSTEM_MCP_MOUNT_PATH = "/mcp/system"
SYSTEM_MCP_TRANSPORT_PATH = "/"
KNOWLEDGE_MCP_MOUNT_PATH = "/mcp/knowledge"
KNOWLEDGE_MCP_TRANSPORT_PATH = "/sse"


@dataclass(frozen=True)
class McpAppSpec:
    name: str
    service_name: str
    mount_path: str
    transport_path: str
    server: FastMCP
    token_context: contextvars.ContextVar[Optional[TaskTokenInfo]]
    log_prefix: str
    include_root_metadata: bool = True


class EmptyPathToSlashMiddleware:
    """Normalize empty subpaths to '/' to avoid redirect_slashes on mounted apps."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") in {"http", "websocket"} and scope.get("path") == "":
            updated_scope = dict(scope)
            updated_scope["path"] = "/"
            if updated_scope.get("raw_path", b"") == b"":
                updated_scope["raw_path"] = b"/"
            scope = updated_scope

        await self.app(scope, receive, send)


class _ASGIPathAdapter:
    """Adapt an ASGI app to a fixed internal path."""

    def __init__(self, app: ASGIApp, target_path: str = "/") -> None:
        self.app = app
        self.target_path = target_path
        self.target_raw_path = target_path.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        forwarded_scope = dict(scope)
        forwarded_scope["path"] = self.target_path
        forwarded_scope["raw_path"] = self.target_raw_path
        await self.app(forwarded_scope, receive, send)


# ============== System MCP Server ==============
# Provides system-level tools like silent_exit
# Automatically injected into all subscription tasks


def _build_transport_security_settings() -> TransportSecuritySettings:
    if not settings.MCP_ENABLE_DNS_REBINDING_PROTECTION:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)

    allowed_hosts = settings.MCP_ALLOWED_HOSTS
    if not allowed_hosts:
        logger.warning(
            "MCP DNS rebinding protection enabled but MCP_ALLOWED_HOSTS is empty. "
            "Disabling protection to avoid blocking all requests."
        )
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=settings.MCP_ALLOWED_ORIGINS,
    )


system_mcp_server = FastMCP(
    "wegent-system-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=_build_transport_security_settings(),
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
    transport_security=_build_transport_security_settings(),
)

# Store for knowledge MCP request context (used by McpAppSpec)
_knowledge_request_token_info: contextvars.ContextVar[Optional[TaskTokenInfo]] = (
    contextvars.ContextVar("_knowledge_request_token_info", default=None)
)

# Flag to track if tools have been registered
_knowledge_tools_registered = False


def _register_knowledge_tools() -> None:
    """Register knowledge tools from @mcp_tool decorated endpoints.

    This function imports the knowledge tools module to trigger decorator
    registration, then registers all collected tools to the knowledge MCP server.
    """
    global _knowledge_tools_registered
    if _knowledge_tools_registered:
        return

    # Import MCP tools module to trigger @mcp_tool decorator registration
    # The decorators will add tools to the global registry
    from app.mcp_server.tool_registry import register_tools_to_server
    from app.mcp_server.tools import (  # noqa: F401 side-effect: triggers @mcp_tool registration
        knowledge,
    )

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

_SYSTEM_MCP_SPEC = McpAppSpec(
    name="system",
    service_name="wegent-system-mcp",
    mount_path=SYSTEM_MCP_MOUNT_PATH,
    transport_path=SYSTEM_MCP_TRANSPORT_PATH,
    server=system_mcp_server,
    token_context=_system_request_token_info,
    log_prefix="System",
    include_root_metadata=False,
)

_KNOWLEDGE_MCP_SPEC = McpAppSpec(
    name="knowledge",
    service_name="wegent-knowledge-mcp",
    mount_path=KNOWLEDGE_MCP_MOUNT_PATH,
    transport_path=KNOWLEDGE_MCP_TRANSPORT_PATH,
    server=knowledge_mcp_server,
    token_context=_knowledge_request_token_info,
    log_prefix="Knowledge",
    include_root_metadata=True,
)

MCP_APP_SPECS = (_SYSTEM_MCP_SPEC, _KNOWLEDGE_MCP_SPEC)


def _build_root_metadata(spec: McpAppSpec) -> Dict[str, Any]:
    return {
        "service": spec.service_name,
        "transport": "streamable-http",
        "endpoints": {
            "mcp": f"{spec.mount_path}{spec.transport_path}",
            "health": f"{spec.mount_path}/health",
        },
    }


def _build_mcp_app(spec: McpAppSpec) -> Starlette:
    """Create a Starlette app for a streamable-http MCP server."""
    # Ensure knowledge tools are registered before creating the app
    if spec.name == "knowledge":
        ensure_knowledge_tools_registered()

    async def health_check(request: Request) -> JSONResponse:
        return JSONResponse({"status": "healthy", "service": spec.service_name})

    async def root_metadata(request: Request) -> JSONResponse:
        return JSONResponse(_build_root_metadata(spec))

    async def auth_middleware(request: Request, call_next):
        """Middleware to extract and validate task token.

        Sets MCPRequestContext for the request scope, enabling decorator-based
        tools to access authentication info via context accessors.
        """
        auth_header = request.headers.get("authorization", "")
        token = extract_token_from_header(auth_header)

        token_info: Optional[TaskTokenInfo] = None
        mcp_ctx_token = None

        if token:
            token_info = verify_task_token(token)
            if token_info:
                logger.debug(
                    "[MCP:%s] Authenticated: task=%s, subtask=%s, user=%s",
                    spec.log_prefix,
                    token_info.task_id,
                    token_info.subtask_id,
                    token_info.user_name,
                )
                # Set MCPRequestContext for decorator-based tools (knowledge server)
                if spec.name == "knowledge":
                    mcp_ctx = MCPRequestContext(
                        token_info=token_info,
                        tool_name="",  # Will be set by tool invocation
                        server_name="knowledge",
                    )
                    mcp_ctx_token = set_mcp_context(mcp_ctx)
            else:
                logger.warning("[MCP:%s] Invalid task token", spec.log_prefix)

        # Set token info in spec's context var
        ctx_token = spec.token_context.set(token_info)
        try:
            response = await call_next(request)
            return response
        finally:
            spec.token_context.reset(ctx_token)
            # Reset MCPRequestContext after request completes
            if mcp_ctx_token:
                reset_mcp_context(mcp_ctx_token)

    routes = [
        Route("/health", health_check, methods=["GET"]),
        Route(
            spec.transport_path,
            endpoint=_ASGIPathAdapter(
                spec.server.streamable_http_app(),
                target_path="/",
            ),
            methods=MCP_TRANSPORT_METHODS,
        ),
    ]

    if spec.include_root_metadata and spec.transport_path != "/":
        routes.insert(0, Route("/", root_metadata, methods=["GET"]))

    base_app = Starlette(debug=False, routes=routes)

    from starlette.middleware.base import BaseHTTPMiddleware

    class AuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            return await auth_middleware(request, call_next)

    base_app.add_middleware(AuthMiddleware)
    base_app.add_middleware(EmptyPathToSlashMiddleware)

    return base_app


def _create_system_mcp_app() -> Starlette:
    """Create Starlette app for system MCP server."""
    return _build_mcp_app(_SYSTEM_MCP_SPEC)


def _create_knowledge_mcp_app() -> Starlette:
    """Create Starlette app for knowledge MCP server."""
    return _build_mcp_app(_KNOWLEDGE_MCP_SPEC)


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

    # Create sub-applications
    @router.get("/mcp/system/health")
    async def system_health():
        return {"status": "healthy", "service": "wegent-system-mcp"}

    @router.get("/mcp/knowledge/health")
    async def knowledge_health():
        return {"status": "healthy", "service": "wegent-knowledge-mcp"}

    return router, system_app, knowledge_app


def register_mcp_apps(app: FastAPI, mount_prefix: str = "") -> None:
    """Register all internal MCP sub-apps on the FastAPI instance."""
    normalized_prefix = _normalize_prefix(mount_prefix)
    for spec in MCP_APP_SPECS:
        effective_spec = _apply_mount_prefix(spec, normalized_prefix)
        mcp_app = _build_mcp_app(effective_spec)

        if effective_spec.transport_path == "/":
            app.add_route(
                effective_spec.mount_path,
                _ASGIPathAdapter(mcp_app, target_path="/"),
                methods=MCP_TRANSPORT_METHODS,
            )

        app.mount(effective_spec.mount_path, mcp_app)
        logger.info(
            "Mounted MCP server '%s' at %s (transport: %s)",
            effective_spec.name,
            effective_spec.mount_path,
            effective_spec.transport_path,
        )


def get_mcp_system_config(backend_url: str, task_token: str) -> Dict[str, Any]:
    """Get system MCP server configuration for task injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        task_token: Task token for authentication

    Returns:
        MCP server configuration dictionary
    """
    return _build_streamable_http_config(
        name="wegent-system",
        url=f"{backend_url}{SYSTEM_MCP_MOUNT_PATH}",
        task_token=task_token,
        timeout=60,
    )


def get_mcp_knowledge_config(backend_url: str, task_token: str) -> Dict[str, Any]:
    """Get knowledge MCP server configuration for Skill injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        task_token: Task token for authentication (uses placeholder for Skill)

    Returns:
        MCP server configuration dictionary
    """
    return _build_streamable_http_config(
        name="wegent-knowledge",
        url=f"{backend_url}{KNOWLEDGE_MCP_MOUNT_PATH}{KNOWLEDGE_MCP_TRANSPORT_PATH}",
        task_token=task_token,
        timeout=300,  # 5 minutes for document operations
    )


def _normalize_prefix(prefix: str) -> str:
    if not prefix:
        return ""

    if not prefix.startswith("/"):
        prefix = f"/{prefix}"

    return prefix.rstrip("/")


def _apply_mount_prefix(spec: McpAppSpec, prefix: str) -> McpAppSpec:
    if not prefix:
        return spec

    return replace(spec, mount_path=f"{prefix}{spec.mount_path}")


def _build_streamable_http_config(
    name: str, url: str, task_token: str, timeout: int
) -> Dict[str, Any]:
    return {
        name: {
            "type": "streamable-http",
            "url": url,
            "headers": {
                "Authorization": f"Bearer {task_token}",
            },
            "timeout": timeout,
        }
    }
