# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime bridge from Wegent connector apps to upstream MCP servers."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.connector import ConnectorApp, ConnectorConnection
from app.models.user import User
from app.schemas.connector import ConnectorTool
from app.services.connector_apps import (
    ConnectorAppService,
    _decrypt_json,
    _token_expiry,
)
from shared.telemetry.decorators import trace_async
from shared.utils.crypto import (
    decrypt_sensitive_data_with_embedded_iv,
    encrypt_sensitive_data_with_embedded_iv,
)

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class ConnectorRuntimeService:
    """List and invoke tools for the current user's connected apps."""

    @staticmethod
    @trace_async(
        "connector.runtime.list_tools",
        "backend.connector",
        extract_attributes=lambda db, user: {"user.id": str(user.id)},
    )
    async def list_tools(db: Session, user: User) -> list[ConnectorTool]:
        tools: list[ConnectorTool] = []
        for app, connection in ConnectorRuntimeService._connected_apps(db, user):
            try:
                upstream_tools = await ConnectorRuntimeService._upstream_tools(
                    db, app, connection
                )
            except HTTPException as exc:
                logger.warning(
                    "Skipping unavailable connector '%s' during tool discovery: %s",
                    app.slug,
                    exc.detail,
                )
                continue
            allowlist = set(app.tool_allowlist or [])
            for tool in upstream_tools:
                upstream_name = tool.name
                if allowlist and upstream_name not in allowlist:
                    continue
                tools.append(
                    ConnectorTool(
                        name=f"{app.slug}__{upstream_name}",
                        title=getattr(tool, "title", None),
                        description=getattr(tool, "description", "") or "",
                        input_schema=getattr(tool, "inputSchema", None)
                        or {"type": "object", "properties": {}},
                        annotations=ConnectorRuntimeService._model_dump(
                            getattr(tool, "annotations", None)
                        ),
                        app_id=app.id,
                        app_slug=app.slug,
                        app_name=app.name,
                    )
                )
        return tools

    @staticmethod
    @trace_async(
        "connector.runtime.call_tool",
        "backend.connector",
        extract_attributes=lambda db, user, name, arguments: {
            "user.id": str(user.id),
            "connector.tool": name,
        },
    )
    async def call_tool(
        db: Session, user: User, name: str, arguments: dict[str, Any]
    ) -> tuple[Any, dict[str, Any] | None, bool]:
        app_slug, separator, upstream_name = name.partition("__")
        if not separator or not app_slug or not upstream_name:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Invalid connector tool name"
            )
        app = (
            db.query(ConnectorApp)
            .filter(ConnectorApp.slug == app_slug, ConnectorApp.enabled.is_(True))
            .first()
        )
        visible_ids = {
            item.id for item in ConnectorAppService.list_visible_apps(db, user)
        }
        if not app or app.id not in visible_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector app not found")
        connection = ConnectorAppService.connection(db, user.id, app.id)
        if app.auth_type != "none" and (
            not connection or connection.status != "connected"
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Connector app is not connected"
            )
        allowlist = set(app.tool_allowlist or [])
        if allowlist and upstream_name not in allowlist:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Connector tool is disabled")
        config = await ConnectorRuntimeService._server_config(db, app, connection)
        try:
            async with ConnectorRuntimeService._mcp_session(config) as session:
                tool = await ConnectorRuntimeService._find_tool(session, upstream_name)
                if not tool:
                    raise HTTPException(
                        status.HTTP_404_NOT_FOUND, "Connector tool not found"
                    )
                result = await session.call_tool(tool.name, arguments)
                return (
                    ConnectorRuntimeService._json_safe(result.content),
                    ConnectorRuntimeService._json_safe(result.structuredContent),
                    bool(result.isError),
                )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Connector tool execution failed",
            ) from exc

    @staticmethod
    def _connected_apps(
        db: Session, user: User
    ) -> list[tuple[ConnectorApp, ConnectorConnection | None]]:
        apps = ConnectorAppService.list_visible_apps(db, user)
        if not apps:
            return []
        connections = {
            connection.app_id: connection
            for connection in db.query(ConnectorConnection)
            .filter(
                ConnectorConnection.user_id == user.id,
                ConnectorConnection.app_id.in_([app.id for app in apps]),
            )
            .all()
        }
        return [
            (app, connections.get(app.id))
            for app in apps
            if app.auth_type == "none"
            or (
                connections.get(app.id) is not None
                and connections[app.id].status == "connected"
            )
        ]

    @staticmethod
    async def _upstream_tools(
        db: Session, app: ConnectorApp, connection: ConnectorConnection | None
    ) -> list[Any]:
        try:
            config = await ConnectorRuntimeService._server_config(db, app, connection)
            async with ConnectorRuntimeService._mcp_session(config) as session:
                return await ConnectorRuntimeService._list_all_tools(session)
        except Exception as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"Failed to list tools for connector '{app.slug}'",
            ) from exc

    @staticmethod
    @asynccontextmanager
    async def _mcp_session(config: dict[str, Any]) -> AsyncIterator[Any]:
        from mcp import ClientSession
        from mcp.client.sse import sse_client
        from mcp.client.streamable_http import streamablehttp_client

        transport = config["type"]
        client = sse_client if transport == "sse" else streamablehttp_client
        async with client(
            url=config["url"],
            headers=config.get("headers") or None,
            timeout=30,
            sse_read_timeout=180,
        ) as streams:
            read_stream, write_stream = streams[:2]
            async with ClientSession(
                read_stream,
                write_stream,
                read_timeout_seconds=timedelta(seconds=180),
            ) as session:
                await session.initialize()
                yield session

    @staticmethod
    async def _list_all_tools(session: Any) -> list[Any]:
        tools: list[Any] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            result = await session.list_tools(cursor=cursor)
            tools.extend(result.tools)
            cursor = result.nextCursor
            if not cursor:
                return tools
            if cursor in seen_cursors:
                raise RuntimeError("MCP tools/list returned a repeated cursor")
            seen_cursors.add(cursor)

    @staticmethod
    async def _find_tool(session: Any, name: str) -> Any | None:
        for tool in await ConnectorRuntimeService._list_all_tools(session):
            if tool.name == name:
                return tool
        return None

    @staticmethod
    async def _server_config(
        db: Session, app: ConnectorApp, connection: ConnectorConnection | None
    ) -> dict[str, Any]:
        if connection:
            await ConnectorRuntimeService._refresh_oauth_if_needed(db, app, connection)
        headers = _decrypt_json(app.provider_headers_encrypted)
        if connection and connection.access_token_encrypted:
            access_token = decrypt_sensitive_data_with_embedded_iv(
                connection.access_token_encrypted
            )
            if access_token:
                headers["Authorization"] = (
                    f"{connection.token_type or 'Bearer'} {access_token}"
                )
        return {
            "type": app.transport,
            "url": app.mcp_url,
            "headers": headers,
        }

    @staticmethod
    async def _refresh_oauth_if_needed(
        db: Session, app: ConnectorApp, connection: ConnectorConnection
    ) -> None:
        if (
            app.auth_type != "oauth2"
            or connection.expires_at is None
            or connection.expires_at > _utcnow() + timedelta(seconds=60)
        ):
            return
        connection = (
            db.query(ConnectorConnection)
            .filter(ConnectorConnection.id == connection.id)
            .with_for_update()
            .populate_existing()
            .one()
        )
        if (
            connection.expires_at is None
            or connection.expires_at > _utcnow() + timedelta(seconds=60)
        ):
            db.commit()
            return
        refresh_token = decrypt_sensitive_data_with_embedded_iv(
            connection.refresh_token_encrypted or ""
        )
        if not refresh_token:
            connection.status = "expired"
            db.commit()
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, "Connector authorization expired"
            )
        client_secret = decrypt_sensitive_data_with_embedded_iv(
            app.oauth_client_secret_encrypted or ""
        )
        data = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": app.oauth_client_id,
        }
        request_auth = None
        if client_secret and app.oauth_client_auth_method == "client_secret_basic":
            request_auth = (app.oauth_client_id, client_secret)
        elif client_secret and app.oauth_client_auth_method == "client_secret_post":
            data["client_secret"] = client_secret
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    app.oauth_token_url, data=data, auth=request_auth
                )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "Connector refresh is unavailable"
            ) from exc
        if response.is_error:
            connection.status = "expired"
            db.commit()
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, "Connector refresh failed"
            )
        try:
            token = response.json()
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "Connector refresh response is invalid"
            ) from exc
        if not isinstance(token, dict):
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "Connector refresh response is invalid"
            )
        access_token = token.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "Refreshed token is missing"
            )
        connection.access_token_encrypted = encrypt_sensitive_data_with_embedded_iv(
            access_token
        )
        next_refresh_token = token.get("refresh_token")
        if isinstance(next_refresh_token, str) and next_refresh_token:
            connection.refresh_token_encrypted = (
                encrypt_sensitive_data_with_embedded_iv(next_refresh_token)
            )
        connection.token_type = str(
            token.get("token_type") or connection.token_type or "Bearer"
        )
        raw_scope = token.get("scope")
        if isinstance(raw_scope, str):
            connection.granted_scopes = raw_scope.split()
        connection.expires_at = _token_expiry(token.get("expires_in"))
        connection.status = "connected"
        db.commit()

    @staticmethod
    def _model_dump(value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        if isinstance(value, dict):
            return value
        if hasattr(value, "model_dump"):
            return value.model_dump(mode="json", by_alias=True, exclude_none=True)
        return None

    @staticmethod
    def _json_safe(value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, dict):
            return {
                str(key): ConnectorRuntimeService._json_safe(item)
                for key, item in value.items()
            }
        if isinstance(value, (list, tuple)):
            return [ConnectorRuntimeService._json_safe(item) for item in value]
        if hasattr(value, "model_dump"):
            return ConnectorRuntimeService._json_safe(
                value.model_dump(mode="json", by_alias=True, exclude_none=True)
            )
        return str(value)


connector_runtime_service = ConnectorRuntimeService()
