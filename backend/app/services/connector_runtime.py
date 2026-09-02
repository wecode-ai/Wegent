# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime bridge from Wegent connector apps to upstream tool servers."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from types import MappingProxyType
from typing import Any
from urllib.parse import quote

import httpx
import mcp
from fastapi import HTTPException, status
from jsonschema import SchemaError, ValidationError, validate
from mcp.client import sse, streamable_http
from sqlalchemy.orm import Session

from app.core.payload_codec import run_payload_codec
from app.schemas.connector import (
    ConnectorHttpToolDefinition,
    ConnectorTool,
    ConnectorToolCallRequest,
)
from app.services.chat.storage.db import run_sync_in_executor
from app.services.connector_apps import (
    ConnectorApp,
    _decrypt_json,
    connector_app_service,
)
from app.services.connector_connections import connector_connection_service
from app.services.connector_oauth import connector_oauth_service
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
MAX_HTTP_RESPONSE_BYTES = 1_000_000


@dataclass(frozen=True)
class ConnectorServerConfig:
    """Immutable provider configuration detached from SQLAlchemy state."""

    transport: str
    url: str
    headers: Mapping[str, str]


@dataclass(frozen=True)
class ConnectorRuntimePlan:
    """One detached app invocation/discovery plan."""

    app: ConnectorApp
    config: ConnectorServerConfig | None
    refresh_required: bool = False


class ConnectorRuntimeService:
    """List and invoke tools without holding DB state during network waits."""

    def __init__(self, session_factory: Callable[[], Session] | None = None) -> None:
        self._configured_session_factory = session_factory

    def _session_factory(self) -> Session:
        if self._configured_session_factory is not None:
            return self._configured_session_factory()
        from app.db.session import SessionLocal

        return SessionLocal()

    @trace_async(
        "connector.runtime.list_tools",
        "backend.connector",
        extract_attributes=lambda self, user_id, user_name, user_role: {
            "user.id": str(user_id)
        },
    )
    async def list_tools(
        self,
        user_id: int,
        user_name: str,
        user_role: str,
    ) -> list[ConnectorTool]:
        plans = await run_sync_in_executor(
            self._prepare_list_sync, user_id, user_name, user_role
        )
        tools: tuple[ConnectorTool, ...] = ()
        for plan in plans:
            if plan.app.transport == "http":
                projected = await run_payload_codec(
                    self._http_tools,
                    plan.app,
                    payload_hint=plan.app.http_tools,
                    force_offload=True,
                )
                tools = await run_payload_codec(
                    self._merge_tools,
                    tools,
                    projected,
                    payload_hint=(tools, projected),
                    force_offload=True,
                )
                continue
            try:
                upstream_tools = await self._upstream_tools(plan)
                projected = await run_payload_codec(
                    self._tools_from_upstream,
                    plan.app,
                    upstream_tools,
                    True,
                    payload_hint=upstream_tools,
                    force_offload=True,
                )
                tools = await run_payload_codec(
                    self._merge_tools,
                    tools,
                    projected,
                    payload_hint=(tools, projected),
                    force_offload=True,
                )
            except HTTPException as exc:
                logger.warning(
                    "Skipping unavailable connector '%s' during tool discovery: %s",
                    plan.app.slug,
                    exc.detail,
                )
        return await run_payload_codec(
            list,
            tools,
            payload_hint=tools,
            force_offload=True,
        )

    async def discover_tools(
        self,
        app_id: int,
        user_id: int,
        user_name: str,
    ) -> list[ConnectorTool]:
        plan = await run_sync_in_executor(
            self._prepare_admin_discovery_sync, app_id, user_id, user_name
        )
        if plan.refresh_required:
            await connector_oauth_service.refresh_connection(
                slug=plan.app.slug, user_id=user_id
            )
            plan = await run_sync_in_executor(
                self._prepare_admin_discovery_sync, app_id, user_id, user_name
            )
        if plan.app.transport == "http":
            return await run_payload_codec(
                self._http_tools,
                plan.app,
                payload_hint=plan.app.http_tools,
                force_offload=True,
            )
        upstream_tools = await self._upstream_tools(plan)
        return await run_payload_codec(
            self._tools_from_upstream,
            plan.app,
            upstream_tools,
            False,
            payload_hint=upstream_tools,
            force_offload=True,
        )

    @trace_async(
        "connector.runtime.call_tool",
        "backend.connector",
        extract_attributes=lambda self, user_id, user_name, user_role, request: {
            "user.id": str(user_id),
            "connector.tool": request.name,
        },
    )
    async def call_tool(
        self,
        user_id: int,
        user_name: str,
        user_role: str,
        request: ConnectorToolCallRequest,
    ) -> tuple[Any, dict[str, Any] | None, bool]:
        plan = await run_sync_in_executor(
            self._prepare_call_sync,
            user_id,
            user_name,
            user_role,
            request.name,
        )
        if plan.refresh_required:
            await connector_oauth_service.refresh_connection(
                slug=plan.app.slug, user_id=user_id
            )
            plan = await run_sync_in_executor(
                self._prepare_call_sync,
                user_id,
                user_name,
                user_role,
                request.name,
            )
        upstream_name = request.name.partition("__")[2]
        if plan.app.transport == "http":
            definition = await run_payload_codec(
                self._http_tool_definition,
                plan.app,
                upstream_name,
                payload_hint=plan.app.http_tools,
                force_offload=True,
            )
            return await self._call_http_tool(
                self._require_config(plan), definition, request.arguments
            )
        try:
            async with self._mcp_session(self._require_config(plan)) as session:
                tool_name = await self._find_tool_name(session, upstream_name)
                if tool_name is None:
                    raise HTTPException(
                        status.HTTP_404_NOT_FOUND, "Connector tool not found"
                    )
                result = await session.call_tool(tool_name, request.arguments)
            return await run_payload_codec(
                self._project_tool_result,
                result,
                payload_hint=result,
                force_offload=True,
            )
        except HTTPException:
            raise
        except Exception as exc:
            await self._mark_expired_on_auth_error(plan.app, user_id, exc)
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "Connector tool execution failed"
            ) from exc

    async def call_admin_tool(
        self,
        app_id: int,
        user_id: int,
        user_name: str,
        user_role: str,
        request: ConnectorToolCallRequest,
    ) -> tuple[Any, dict[str, Any] | None, bool]:
        normalized = await run_sync_in_executor(
            self._normalize_admin_request_sync, app_id, request
        )
        return await self.call_tool(user_id, user_name, user_role, normalized)

    def _prepare_list_sync(
        self,
        user_id: int,
        user_name: str,
        user_role: str,
    ) -> tuple[ConnectorRuntimePlan, ...]:
        with self._session_factory() as db:
            plans: list[ConnectorRuntimePlan] = []
            for app in connector_app_service.list_visible_apps(db, user_role):
                try:
                    plan = self._plan_for_app_sync(
                        db, app, user_id, user_name, allow_expired=False
                    )
                except HTTPException:
                    continue
                plans.append(plan)
            return tuple(plans)

    def _prepare_call_sync(
        self,
        user_id: int,
        user_name: str,
        user_role: str,
        tool_name: str,
    ) -> ConnectorRuntimePlan:
        app_slug, separator, upstream_name = tool_name.partition("__")
        if not separator or not app_slug or not upstream_name:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Invalid connector tool name"
            )
        with self._session_factory() as db:
            app = connector_app_service.get_app_by_slug(db, app_slug)
            visible_ids = {
                item.id
                for item in connector_app_service.list_visible_apps(db, user_role)
            }
            if app is None or app.id not in visible_ids:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "Connector app not found"
                )
            if app.tool_allowlist and upstream_name not in app.tool_allowlist:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN, "Connector tool is disabled"
                )
            return self._plan_for_app_sync(
                db, app, user_id, user_name, allow_expired=True
            )

    def _prepare_admin_discovery_sync(
        self,
        app_id: int,
        user_id: int,
        user_name: str,
    ) -> ConnectorRuntimePlan:
        with self._session_factory() as db:
            app = connector_app_service.get_app(db, app_id)
            return self._plan_for_app_sync(
                db, app, user_id, user_name, allow_expired=True
            )

    def _normalize_admin_request_sync(
        self,
        app_id: int,
        request: ConnectorToolCallRequest,
    ) -> ConnectorToolCallRequest:
        with self._session_factory() as db:
            app = connector_app_service.get_app(db, app_id)
            name = (
                request.name
                if request.name.startswith(f"{app.slug}__")
                else f"{app.slug}__{request.name}"
            )
            return request.model_copy(update={"name": name})

    @staticmethod
    def _plan_for_app_sync(
        db: Session,
        app: ConnectorApp,
        user_id: int,
        user_name: str,
        *,
        allow_expired: bool,
    ) -> ConnectorRuntimePlan:
        headers = _decrypt_json(app.provider_headers_encrypted)
        if app.auth_type != "none":
            connection = connector_connection_service.get(
                db, slug=app.slug, user_id=user_id
            )
            response = connector_connection_service.response(connection)
            if response.status == "expired" and allow_expired:
                return ConnectorRuntimePlan(app=app, config=None, refresh_required=True)
            if response.status != "connected" or connection is None:
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    f"Connector '{app.slug}' requires authorization",
                )
            access_token = connection.access_token()
            if not access_token:
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    f"Connector '{app.slug}' authorization is unavailable",
                )
            headers["Authorization"] = f"Bearer {access_token}"
        headers["X-Wegent-Username"] = user_name
        headers["X-Wegent-User-Id"] = str(user_id)
        return ConnectorRuntimePlan(
            app=app,
            config=ConnectorServerConfig(
                transport=app.transport,
                url=app.mcp_url,
                headers=MappingProxyType(headers),
            ),
        )

    async def _mark_expired_on_auth_error(
        self, app: ConnectorApp, user_id: int, error: Exception
    ) -> None:
        if app.auth_type == "none":
            return
        is_auth_error = await run_payload_codec(
            self._is_auth_error,
            error,
            payload_hint=error,
            force_offload=True,
        )
        if not is_auth_error:
            return
        await run_sync_in_executor(self._mark_expired_sync, app.slug, user_id)

    @staticmethod
    def _is_auth_error(error: Exception) -> bool:
        message = str(error).lower()
        return any(
            marker in message for marker in ("401", "403", "unauthorized", "forbidden")
        )

    def _mark_expired_sync(self, slug: str, user_id: int) -> None:
        with self._session_factory() as db:
            connection = connector_connection_service.get(
                db, slug=slug, user_id=user_id
            )
            if connection is not None:
                connector_connection_service.set_status(db, connection, "expired")

    @staticmethod
    def _require_config(plan: ConnectorRuntimePlan) -> ConnectorServerConfig:
        if plan.config is None:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                f"Connector '{plan.app.slug}' requires authorization",
            )
        return plan.config

    @staticmethod
    def _http_tools(app: ConnectorApp) -> list[ConnectorTool]:
        return [
            ConnectorTool(
                name=f"{app.slug}__{definition.name}",
                description=definition.description,
                input_schema=definition.input_schema,
                connector_id=app.slug,
                connector_slug=app.slug,
                connector_name=app.name,
                raw_tool_name=definition.name,
                model_visible=True,
                risk_hints={
                    "destructive": definition.method in {"DELETE", "PUT", "PATCH"},
                    "open_world": True,
                },
                source_transport=app.transport,
                app_id=app.id,
                app_slug=app.slug,
                app_name=app.name,
            )
            for definition in app.http_tools
            if not app.tool_allowlist or definition.name in app.tool_allowlist
        ]

    @staticmethod
    def _tools_from_upstream(
        app: ConnectorApp,
        upstream_tools: list[Any],
        enforce_allowlist: bool,
    ) -> list[ConnectorTool]:
        return [
            ConnectorRuntimeService._tool_from_upstream(app, tool)
            for tool in upstream_tools
            if not enforce_allowlist
            or not app.tool_allowlist
            or tool.name in app.tool_allowlist
        ]

    @staticmethod
    def _merge_tools(
        current: tuple[ConnectorTool, ...],
        additions: list[ConnectorTool],
    ) -> tuple[ConnectorTool, ...]:
        return current + tuple(additions)

    @staticmethod
    def _tool_from_upstream(app: ConnectorApp, tool: Any) -> ConnectorTool:
        upstream_name = tool.name
        return ConnectorTool(
            name=f"{app.slug}__{upstream_name}",
            title=getattr(tool, "title", None),
            description=getattr(tool, "description", "") or "",
            input_schema=getattr(tool, "inputSchema", None)
            or {"type": "object", "properties": {}},
            annotations=ConnectorRuntimeService._model_dump(
                getattr(tool, "annotations", None)
            ),
            connector_id=app.slug,
            connector_slug=app.slug,
            connector_name=app.name,
            raw_tool_name=upstream_name,
            model_visible=True,
            risk_hints=ConnectorRuntimeService._risk_hints(tool),
            source_transport=app.transport,
            app_id=app.id,
            app_slug=app.slug,
            app_name=app.name,
        )

    @staticmethod
    def _http_tool_definition(
        app: ConnectorApp, name: str
    ) -> ConnectorHttpToolDefinition:
        definition = next((item for item in app.http_tools if item.name == name), None)
        if definition is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector tool not found")
        return definition

    async def _upstream_tools(self, plan: ConnectorRuntimePlan) -> list[Any]:
        try:
            async with self._mcp_session(self._require_config(plan)) as session:
                return await self._list_all_tools(session)
        except Exception as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"Failed to list tools for connector '{plan.app.slug}'",
            ) from exc

    @staticmethod
    @trace_async("connector.runtime.call_http", "backend.connector")
    async def _call_http_tool(
        config: ConnectorServerConfig,
        definition: ConnectorHttpToolDefinition,
        arguments: dict[str, Any],
    ) -> tuple[Any, dict[str, Any] | None, bool]:
        request = await run_payload_codec(
            ConnectorRuntimeService._build_http_request,
            config,
            definition,
            arguments,
            payload_hint=arguments,
            force_offload=True,
        )
        try:
            async with httpx.AsyncClient(
                timeout=definition.timeout_seconds, follow_redirects=False
            ) as client:
                response = await client.send(request, stream=True)
                try:
                    content = await ConnectorRuntimeService._bounded_response_body(
                        response
                    )
                    response_encoding = response.encoding
                    response_status = response.status_code
                finally:
                    await response.aclose()
        except httpx.HTTPError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "Connector HTTP request failed"
            ) from exc
        return await run_payload_codec(
            ConnectorRuntimeService._http_response,
            response_status,
            content,
            response_encoding,
            payload_hint=content,
            force_offload=True,
        )

    @staticmethod
    def _build_http_request(
        config: ConnectorServerConfig,
        definition: ConnectorHttpToolDefinition,
        arguments: dict[str, Any],
    ) -> httpx.Request:
        ConnectorRuntimeService._validate_http_arguments(definition, arguments)
        url, query, body = ConnectorRuntimeService._http_request_parts(
            config.url, definition, arguments
        )
        return httpx.Request(
            definition.method,
            url,
            headers=config.headers,
            params=query or None,
            json=body or None,
        )

    @staticmethod
    async def _bounded_response_body(response: httpx.Response) -> bytes:
        content_length = response.headers.get("content-length")
        try:
            declared_length = int(content_length) if content_length else None
        except ValueError:
            declared_length = None
        if declared_length is not None and declared_length > MAX_HTTP_RESPONSE_BYTES:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Connector HTTP response exceeds the size limit",
            )
        chunks = bytearray()
        async for chunk in response.aiter_bytes():
            chunks.extend(chunk)
            if len(chunks) > MAX_HTTP_RESPONSE_BYTES:
                raise HTTPException(
                    status.HTTP_502_BAD_GATEWAY,
                    "Connector HTTP response exceeds the size limit",
                )
        return bytes(chunks)

    @staticmethod
    def _validate_http_arguments(
        definition: ConnectorHttpToolDefinition, arguments: dict[str, Any]
    ) -> None:
        try:
            validate(instance=arguments, schema=definition.input_schema)
        except ValidationError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Invalid connector tool arguments: {exc.message}",
            ) from exc
        except SchemaError as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Connector HTTP tool schema is invalid",
            ) from exc

    @staticmethod
    def _http_request_parts(
        base_url: str,
        definition: ConnectorHttpToolDefinition,
        arguments: dict[str, Any],
    ) -> tuple[str, dict[str, Any], dict[str, Any]]:
        path = definition.path
        query: dict[str, Any] = {}
        body: dict[str, Any] = {}
        for name, value in arguments.items():
            location = definition.argument_locations.get(name)
            if location == "path" or "{" + name + "}" in path:
                if isinstance(value, (dict, list)):
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_ENTITY,
                        f"HTTP path argument '{name}' must be scalar",
                    )
                path = path.replace("{" + name + "}", quote(str(value), safe=""))
            elif location == "query" or (
                location is None and definition.method in {"GET", "DELETE"}
            ):
                query[name] = value
            else:
                body[name] = value
        if "{" in path or "}" in path:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "A required HTTP path argument is missing",
            )
        return f"{base_url.rstrip('/')}{path}", query, body

    @staticmethod
    def _http_response(
        status_code: int, content: bytes, encoding: str | None
    ) -> tuple[Any, dict[str, Any] | None, bool]:
        try:
            payload: Any = json.loads(content)
        except (UnicodeDecodeError, ValueError):
            payload = content.decode(encoding or "utf-8", errors="replace")
        text = (
            payload
            if isinstance(payload, str)
            else json.dumps(payload, ensure_ascii=False)
        )
        structured = (
            {"status_code": status_code, "data": payload}
            if isinstance(payload, (dict, list))
            else None
        )
        return (
            [{"type": "text", "text": text}],
            structured,
            not 200 <= status_code < 300,
        )

    @staticmethod
    @asynccontextmanager
    async def _mcp_session(config: ConnectorServerConfig) -> AsyncIterator[Any]:
        client = (
            sse.sse_client
            if config.transport == "sse"
            else streamable_http.streamablehttp_client
        )
        async with client(
            url=config.url,
            headers=config.headers or None,
            timeout=30,
            sse_read_timeout=180,
        ) as streams:
            read_stream, write_stream = streams[:2]
            async with mcp.ClientSession(
                read_stream,
                write_stream,
                read_timeout_seconds=timedelta(seconds=180),
            ) as session:
                await session.initialize()
                yield session

    @staticmethod
    async def _list_all_tools(session: Any) -> list[Any]:
        tools: tuple[Any, ...] = ()
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            result = await session.list_tools(cursor=cursor)
            tools, cursor = await run_payload_codec(
                ConnectorRuntimeService._merge_upstream_page,
                tools,
                result,
                payload_hint=result,
                force_offload=True,
            )
            if not cursor:
                return await run_payload_codec(
                    list,
                    tools,
                    payload_hint=tools,
                    force_offload=True,
                )
            if cursor in seen_cursors:
                raise RuntimeError("MCP tools/list returned a repeated cursor")
            seen_cursors.add(cursor)

    @staticmethod
    def _merge_upstream_page(
        current: tuple[Any, ...],
        result: Any,
    ) -> tuple[tuple[Any, ...], str | None]:
        return current + tuple(result.tools), result.nextCursor

    @staticmethod
    async def _find_tool_name(session: Any, name: str) -> str | None:
        tools = await ConnectorRuntimeService._list_all_tools(session)
        return await run_payload_codec(
            ConnectorRuntimeService._find_tool_name_sync,
            tools,
            name,
            payload_hint=tools,
            force_offload=True,
        )

    @staticmethod
    def _find_tool_name_sync(tools: list[Any], name: str) -> str | None:
        for tool in tools:
            if tool.name == name:
                return str(tool.name)
        return None

    @staticmethod
    def _project_tool_result(
        result: Any,
    ) -> tuple[Any, dict[str, Any] | None, bool]:
        return (
            ConnectorRuntimeService._json_safe(result.content),
            ConnectorRuntimeService._json_safe(result.structuredContent),
            bool(result.isError),
        )

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
    def _risk_hints(tool: Any) -> dict[str, Any]:
        annotations = ConnectorRuntimeService._model_dump(
            getattr(tool, "annotations", None)
        )
        if not annotations:
            return {}
        return {
            "destructive": bool(
                annotations.get("destructiveHint") or annotations.get("destructive")
            ),
            "open_world": bool(
                annotations.get("openWorldHint") or annotations.get("open_world")
            ),
        }

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
