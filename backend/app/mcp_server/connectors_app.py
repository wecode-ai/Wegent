# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dynamic MCP surface for administrator-published connector apps.

The Chat shell connects to this endpoint with the task token so every
``tools/list`` and ``tools/call`` resolves the calling user's visible apps,
tool allowlists, and OAuth credentials through the connector runtime. Exposing
each upstream directly would bypass the administrator's allowlist.
"""

from __future__ import annotations

import contextvars
import json
import logging
from typing import Any

from fastapi import HTTPException
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, Tool
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.types import Receive, Scope, Send

from app.db.session import SessionLocal
from app.models.user import User
from app.services.connector_runtime import connector_runtime_service

logger = logging.getLogger(__name__)

# Set by the MCP auth middleware for the duration of one HTTP request.
connector_mcp_token_info: contextvars.ContextVar[Any | None] = contextvars.ContextVar(
    "connector_mcp_token_info", default=None
)
connector_mcp_app_slug: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "connector_mcp_app_slug", default=None
)


def current_connector_user_id() -> int | None:
    """Resolve the authenticated user id for the running MCP request."""
    token_info = connector_mcp_token_info.get()
    user_id = getattr(token_info, "user_id", None)
    return user_id if isinstance(user_id, int) else None


def current_connector_app_slug() -> str | None:
    """Resolve the optional per-app scope for a lazy connector Skill."""
    value = connector_mcp_app_slug.get()
    return value.strip() if isinstance(value, str) and value.strip() else None


def _active_user(db: Any, user_id: int | None) -> User | None:
    if user_id is None:
        return None
    user = db.get(User, user_id)
    return user if user and user.is_active else None


async def list_connector_tools() -> list[Tool]:
    with SessionLocal() as db:
        user = _active_user(db, current_connector_user_id())
        if user is None:
            return []
        tools = await connector_runtime_service.list_tools(
            db,
            user,
            app_slug=current_connector_app_slug(),
        )
    return [
        Tool(
            name=tool.name,
            title=tool.title,
            description=tool.description,
            inputSchema=tool.input_schema or {"type": "object"},
        )
        for tool in tools
    ]


async def call_connector_tool(name: str, arguments: dict[str, Any]) -> CallToolResult:
    with SessionLocal() as db:
        user = _active_user(db, current_connector_user_id())
        if user is None:
            return CallToolResult(
                content=[TextContent(type="text", text="Connector user unavailable")],
                isError=True,
            )
        scoped_app_slug = current_connector_app_slug()
        if scoped_app_slug and not name.startswith(f"{scoped_app_slug}__"):
            return CallToolResult(
                content=[
                    TextContent(
                        type="text",
                        text=f"Connector tool '{name}' is outside this Skill's app scope",
                    )
                ],
                isError=True,
            )
        try:
            content, structured, is_error = await connector_runtime_service.call_tool(
                db, user, name, arguments
            )
        except HTTPException as exc:
            return CallToolResult(
                content=[TextContent(type="text", text=_failure_text(name, exc))],
                isError=True,
            )
        except Exception:  # Surface tool failures instead of dropping the call.
            logger.exception("[ConnectorMCP] tool %s failed", name)
            return CallToolResult(
                content=[TextContent(type="text", text="Connector tool failed")],
                isError=True,
            )
    return CallToolResult(
        content=_content_blocks(content),
        structuredContent=structured if isinstance(structured, dict) else None,
        isError=is_error,
    )


def _failure_text(name: str, exc: HTTPException) -> str:
    """Report authorization failures the way the desktop proxy does.

    The agent is instructed to end its turn with ``connector_auth_required`` and
    the app slug when a connector needs a user grant, so return the same
    structured payload the local ``wegent_apps`` proxy produces.
    """
    detail = str(exc.detail)
    if exc.status_code == 401 and "requires authorization" in detail:
        slug = name.split("__", 1)[0]
        return json.dumps(
            {
                "error": "connector_auth_required",
                "connectorSlug": slug,
                "message": detail,
            }
        )
    return detail


def _content_blocks(content: Any) -> list[TextContent]:
    """Keep text blocks readable while preserving JSON-only payloads."""
    if isinstance(content, str):
        return [TextContent(type="text", text=content)]
    if isinstance(content, list):
        texts = [
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ]
        if texts:
            return [TextContent(type="text", text="\n".join(texts))]
    return [TextContent(type="text", text=json.dumps(content, ensure_ascii=False))]


def build_connector_mcp_server() -> Server:
    server = Server("wegent-connectors-mcp")

    @server.list_tools()
    async def _list_tools() -> list[Tool]:
        return await list_connector_tools()

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> CallToolResult:
        return await call_connector_tool(name, arguments)

    return server


class ConnectorMcpApp:
    """Minimal streamable-HTTP wrapper matching the ``McpAppSpec`` shape."""

    def __init__(
        self, server: Server, security: TransportSecuritySettings | None = None
    ) -> None:
        self._session_manager = StreamableHTTPSessionManager(
            app=server,
            json_response=True,
            stateless=True,
            security_settings=security,
        )
        self._app = Starlette(routes=[Mount("/", app=self._handle_request)])

    @property
    def session_manager(self) -> StreamableHTTPSessionManager:
        return self._session_manager

    def streamable_http_app(self) -> Starlette:
        return self._app

    async def _handle_request(self, scope: Scope, receive: Receive, send: Send) -> None:
        app_slug: str | None = None
        for key, value in scope.get("headers") or []:
            if key.lower() == b"x-connector-app":
                app_slug = value.decode("latin-1").strip() or None
                break
        context_token = connector_mcp_app_slug.set(app_slug)
        try:
            await self._session_manager.handle_request(scope, receive, send)
        finally:
            connector_mcp_app_slug.reset(context_token)
