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
INTERACTIVE_FORM_MCP_MOUNT_PATH = "/mcp/interactive-form-question"
INTERACTIVE_FORM_MCP_TRANSPORT_PATH = "/sse"
PROMPT_OPTIMIZATION_MCP_MOUNT_PATH = "/mcp/prompt-optimization"
PROMPT_OPTIMIZATION_MCP_TRANSPORT_PATH = "/sse"
SUBSCRIPTION_MCP_MOUNT_PATH = "/mcp/subscription"
SUBSCRIPTION_MCP_TRANSPORT_PATH = "/sse"


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


# ============== interactive_form_question MCP Server ==============
# Provides interactive user input collection tool
# Available via Skill configuration
# Uses decorator-based auto-registration from @mcp_tool decorated endpoints

interactive_form_question_mcp_server = FastMCP(
    "wegent-interactive-form-question-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=_build_transport_security_settings(),
)

# Store for interactive_form_question MCP request context (used by McpAppSpec)
_interactive_form_question_request_token_info: contextvars.ContextVar[
    Optional[TaskTokenInfo]
] = contextvars.ContextVar(
    "_interactive_form_question_request_token_info", default=None
)

# Flag to track if tools have been registered
_interactive_form_question_tools_registered = False


def _get_interactive_form_question_token_info_from_context() -> Optional[TaskTokenInfo]:
    """Get token info from interactive_form_question MCP request context."""
    return _interactive_form_question_request_token_info.get()


def _register_interactive_form_question_tools() -> None:
    """Register interactive_form_question tools from @mcp_tool decorated endpoints.

    This function imports the interactive_form_question tools module to trigger decorator
    registration, then registers all collected tools to the interactive_form_question MCP server.
    """
    global _interactive_form_question_tools_registered
    if _interactive_form_question_tools_registered:
        return

    # Import MCP tools module to trigger @mcp_tool decorator registration
    from app.mcp_server.tool_registry import register_tools_to_server
    from app.mcp_server.tools import (  # noqa: F401 side-effect: triggers @mcp_tool registration
        interactive_form_question,
    )

    # Register all collected tools to the interactive_form_question server
    count = register_tools_to_server(
        interactive_form_question_mcp_server, "interactive_form_question"
    )
    logger.info(
        f"[MCP:InteractiveForm] Registered {count} tools from decorated endpoints"
    )

    _interactive_form_question_tools_registered = True


def ensure_interactive_form_question_tools_registered() -> None:
    """Ensure interactive_form_question MCP tools are registered.

    This should be called during application startup to register
    all @mcp_tool decorated endpoints as MCP tools.
    """
    _register_interactive_form_question_tools()


# ============== Prompt Optimization MCP Server ==============
# Provides prompt optimization tools
# Available via Skill configuration
# Uses decorator-based auto-registration from @mcp_tool decorated endpoints

prompt_optimization_mcp_server = FastMCP(
    "wegent-prompt-optimization-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=_build_transport_security_settings(),
)

# Store for prompt_optimization MCP request context (used by McpAppSpec)
_prompt_optimization_request_token_info: contextvars.ContextVar[
    Optional[TaskTokenInfo]
] = contextvars.ContextVar("_prompt_optimization_request_token_info", default=None)

# Flag to track if tools have been registered
_prompt_optimization_tools_registered = False


def _get_prompt_optimization_token_info_from_context() -> Optional[TaskTokenInfo]:
    """Get token info from prompt_optimization MCP request context."""
    return _prompt_optimization_request_token_info.get()


def _register_prompt_optimization_tools() -> None:
    """Register prompt_optimization tools from @mcp_tool decorated endpoints.

    This function imports the prompt_optimization tools module to trigger decorator
    registration, then registers all collected tools to the prompt_optimization MCP server.
    """
    global _prompt_optimization_tools_registered
    if _prompt_optimization_tools_registered:
        return

    # Import MCP tools module to trigger @mcp_tool decorator registration
    from app.mcp_server.tool_registry import register_tools_to_server
    from app.mcp_server.tools import (  # noqa: F401 side-effect: triggers @mcp_tool registration
        prompt_optimization,
    )

    # Register all collected tools to the prompt_optimization server
    count = register_tools_to_server(
        prompt_optimization_mcp_server, "prompt_optimization"
    )
    logger.info(
        f"[MCP:PromptOptimization] Registered {count} tools from decorated endpoints"
    )

    _prompt_optimization_tools_registered = True


def ensure_prompt_optimization_tools_registered() -> None:
    """Ensure prompt_optimization MCP tools are registered.

    This should be called during application startup to register
    all @mcp_tool decorated endpoints as MCP tools.
    """
    _register_prompt_optimization_tools()


# ============== Subscription MCP Server ==============
# Provides subscription management tools (preview_subscription, create_subscription)
# Available via Skill configuration
# Uses decorator-based auto-registration from @mcp_tool decorated endpoints

subscription_mcp_server = FastMCP(
    "wegent-subscription-mcp",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=_build_transport_security_settings(),
)

# Store for subscription MCP request context (used by McpAppSpec)
_subscription_request_token_info: contextvars.ContextVar[Optional[TaskTokenInfo]] = (
    contextvars.ContextVar("_subscription_request_token_info", default=None)
)

# Flag to track if tools have been registered
_subscription_tools_registered = False


def _get_subscription_token_info_from_context() -> Optional[TaskTokenInfo]:
    """Get token info from subscription MCP request context."""
    return _subscription_request_token_info.get()


def _register_subscription_tools() -> None:
    """Register subscription tools from @mcp_tool decorated endpoints.

    This function imports the subscription tools module to trigger decorator
    registration, then registers all collected tools to the subscription MCP server.
    """
    global _subscription_tools_registered
    if _subscription_tools_registered:
        return

    # Import MCP tools module to trigger @mcp_tool decorator registration
    from app.mcp_server.tool_registry import register_tools_to_server
    from app.mcp_server.tools import (  # noqa: F401 side-effect: triggers @mcp_tool registration
        subscription,
    )

    # Register all collected tools to the subscription server
    count = register_tools_to_server(subscription_mcp_server, "subscription")
    logger.info(f"[MCP:Subscription] Registered {count} tools from decorated endpoints")

    _subscription_tools_registered = True


def ensure_subscription_tools_registered() -> None:
    """Ensure subscription MCP tools are registered.

    This should be called during application startup to register
    all @mcp_tool decorated endpoints as MCP tools.
    """
    _register_subscription_tools()


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

_INTERACTIVE_FORM_MCP_SPEC = McpAppSpec(
    name="interactive_form_question",
    service_name="wegent-interactive-form-question-mcp",
    mount_path=INTERACTIVE_FORM_MCP_MOUNT_PATH,
    transport_path=INTERACTIVE_FORM_MCP_TRANSPORT_PATH,
    server=interactive_form_question_mcp_server,
    token_context=_interactive_form_question_request_token_info,
    log_prefix="InteractiveForm",
    include_root_metadata=True,
)

_PROMPT_OPTIMIZATION_MCP_SPEC = McpAppSpec(
    name="prompt_optimization",
    service_name="wegent-prompt-optimization-mcp",
    mount_path=PROMPT_OPTIMIZATION_MCP_MOUNT_PATH,
    transport_path=PROMPT_OPTIMIZATION_MCP_TRANSPORT_PATH,
    server=prompt_optimization_mcp_server,
    token_context=_prompt_optimization_request_token_info,
    log_prefix="PromptOptimization",
    include_root_metadata=True,
)

_SUBSCRIPTION_MCP_SPEC = McpAppSpec(
    name="subscription",
    service_name="wegent-subscription-mcp",
    mount_path=SUBSCRIPTION_MCP_MOUNT_PATH,
    transport_path=SUBSCRIPTION_MCP_TRANSPORT_PATH,
    server=subscription_mcp_server,
    token_context=_subscription_request_token_info,
    log_prefix="Subscription",
    include_root_metadata=True,
)

MCP_APP_SPECS = (
    _SYSTEM_MCP_SPEC,
    _KNOWLEDGE_MCP_SPEC,
    _INTERACTIVE_FORM_MCP_SPEC,
    _PROMPT_OPTIMIZATION_MCP_SPEC,
    _SUBSCRIPTION_MCP_SPEC,
)


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
    # Ensure tools are registered before creating the app
    if spec.name == "knowledge":
        ensure_knowledge_tools_registered()
    elif spec.name == "interactive_form_question":
        ensure_interactive_form_question_tools_registered()
    elif spec.name == "prompt_optimization":
        ensure_prompt_optimization_tools_registered()
    elif spec.name == "subscription":
        ensure_subscription_tools_registered()

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
                # Set MCPRequestContext for decorator-based tools
                if spec.name in (
                    "knowledge",
                    "interactive_form_question",
                    "prompt_optimization",
                    "subscription",
                ):
                    mcp_ctx = MCPRequestContext(
                        token_info=token_info,
                        tool_name="",  # Will be set by tool invocation
                        server_name=spec.name,
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


def get_mcp_system_config(backend_url: str, auth_token: str) -> Dict[str, Any]:
    """Get system MCP server configuration for task injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        auth_token: Authentication token for MCP server

    Returns:
        MCP server configuration dictionary
    """
    # Use API_PREFIX to ensure correct path (e.g., /api/mcp/system)
    api_prefix = settings.API_PREFIX or ""
    mcp_path = f"{api_prefix}{SYSTEM_MCP_MOUNT_PATH}"
    return _build_streamable_http_config(
        name="wegent-system",
        url=f"{backend_url}{mcp_path}",
        auth_token=auth_token,
        timeout=60,
    )


def get_mcp_knowledge_config(backend_url: str, auth_token: str) -> Dict[str, Any]:
    """Get knowledge MCP server configuration for Skill injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        auth_token: Authentication token for MCP server (uses placeholder for Skill)

    Returns:
        MCP server configuration dictionary
    """
    return _build_streamable_http_config(
        name="wegent-knowledge",
        url=f"{backend_url}{KNOWLEDGE_MCP_MOUNT_PATH}{KNOWLEDGE_MCP_TRANSPORT_PATH}",
        auth_token=auth_token,
        timeout=300,  # 5 minutes for document operations
    )


def get_mcp_interactive_form_question_config(
    backend_url: str, auth_token: str
) -> Dict[str, Any]:
    """Get interactive_form_question MCP server configuration for Skill injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        auth_token: Authentication token for MCP server (uses placeholder for Skill)

    Returns:
        MCP server configuration dictionary
    """
    return _build_streamable_http_config(
        name="wegent-interactive-form-question",
        url=f"{backend_url}{INTERACTIVE_FORM_MCP_MOUNT_PATH}{INTERACTIVE_FORM_MCP_TRANSPORT_PATH}",
        auth_token=auth_token,
        timeout=300,  # 5 minutes for user response
    )


def get_mcp_prompt_optimization_config(
    backend_url: str, auth_token: str
) -> Dict[str, Any]:
    """Get prompt_optimization MCP server configuration for Skill injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        auth_token: Authentication token for MCP server (uses placeholder for Skill)

    Returns:
        MCP server configuration dictionary
    """
    return _build_streamable_http_config(
        name="wegent-prompt-optimization",
        url=f"{backend_url}{PROMPT_OPTIMIZATION_MCP_MOUNT_PATH}{PROMPT_OPTIMIZATION_MCP_TRANSPORT_PATH}",
        auth_token=auth_token,
        timeout=300,  # 5 minutes for prompt optimization
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
    name: str, url: str, auth_token: str, timeout: int
) -> Dict[str, Any]:
    return {
        name: {
            "type": "streamable-http",
            "url": url,
            "headers": {
                "Authorization": f"Bearer {auth_token}",
            },
            "timeout": timeout,
        }
    }


def get_mcp_subscription_config(backend_url: str, auth_token: str) -> Dict[str, Any]:
    """Get subscription MCP server configuration for Skill injection.

    Args:
        backend_url: Backend URL (e.g., "http://localhost:8000")
        auth_token: Authentication token for MCP server (uses placeholder for Skill)

    Returns:
        MCP server configuration dictionary
    """
    return _build_streamable_http_config(
        name="wegent-subscription",
        url=f"{backend_url}{SUBSCRIPTION_MCP_MOUNT_PATH}{SUBSCRIPTION_MCP_TRANSPORT_PATH}",
        auth_token=auth_token,
        timeout=60,
    )
