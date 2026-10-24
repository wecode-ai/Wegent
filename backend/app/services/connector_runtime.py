# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime bridge from Wegent connector apps to upstream MCP servers."""

from __future__ import annotations

import json
import logging
import time
from asyncio import gather
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import HTTPException, status
from jsonschema import SchemaError, ValidationError, validate
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.connector import ConnectorHttpToolDefinition, ConnectorTool
from app.services.connector_apps import (
    ConnectorApp,
    ConnectorAppService,
    _decrypt_json,
    create_connector_http_client,
)
from app.services.connector_connections import connector_connection_service
from app.services.connector_oauth import connector_oauth_service
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
MAX_HTTP_RESPONSE_BYTES = 1_000_000
# Tool surfaces rarely change; serving a cached copy keeps a chat turn from
# paying one upstream MCP handshake per authorized app.
TOOL_CACHE_TTL_SECONDS = 600


def _exception_texts(error: BaseException, depth: int = 0) -> list[str]:
    """Flatten one exception, its groups, and its causes into readable text."""
    if depth > 8:
        return []
    texts = [f"{type(error).__name__}: {error}"]
    # ``ExceptionGroup`` is built in only from Python 3.11; Python 3.10 may
    # provide the backported type, so duck-type the nested exceptions instead.
    children = getattr(error, "exceptions", None)
    if isinstance(children, (list, tuple)):
        for item in children:
            texts.extend(_exception_texts(item, depth + 1))
    cause = error.__cause__ or error.__context__
    if cause is not None and cause is not error:
        texts.extend(_exception_texts(cause, depth + 1))
    return texts


class ConnectorRuntimeService:
    """List and invoke tools for the current user's connected apps."""

    @staticmethod
    @trace_async(
        "connector.runtime.list_tools",
        "backend.connector",
        extract_attributes=lambda db, user: {"user.id": str(user.id)},
    )
    async def list_tools(
        db: Session,
        user: User,
        *,
        app_slug: str | None = None,
    ) -> list[ConnectorTool]:
        if app_slug:
            apps, connections = ConnectorRuntimeService._connected_apps(
                db, user, app_slug=app_slug
            )
        else:
            apps, connections = ConnectorRuntimeService._connected_apps(db, user)
        if not apps:
            return []

        tools: list[ConnectorTool] = []
        pending: list[tuple[ConnectorApp, list[Any]]] = []
        cached_count = 0
        for app in apps:
            if app.transport == "http":
                tools.extend(ConnectorRuntimeService._http_tools(app))
                continue
            cached = ConnectorRuntimeService._cached_tools(
                app, connections.get(app.slug)
            )
            if cached is None:
                pending.append((app, []))
            else:
                cached_count += 1
                tools.extend(cached)

        if pending:
            started_at = time.monotonic()
            outcomes = await gather(
                *(
                    ConnectorRuntimeService._discover_tools(db, app, user)
                    for app, _ in pending
                ),
                return_exceptions=True,
            )
            for (app, _), outcome in zip(pending, outcomes, strict=True):
                if isinstance(outcome, BaseException):
                    logger.warning(
                        "Skipping unavailable connector '%s' during tool discovery "
                        "(failure=%s): %s",
                        app.slug,
                        type(outcome).__name__,
                        outcome,
                    )
                    if not ConnectorRuntimeService._is_auth_failure(outcome):
                        connection = connections.get(app.slug)
                        if connection is not None:
                            connector_connection_service.record_tool_error(
                                db,
                                connection,
                                " ".join(_exception_texts(outcome))[:500],
                            )
                    continue
                discovered = ConnectorRuntimeService._visible_tools(app, outcome)
                tools.extend(discovered)
                await ConnectorRuntimeService._cache_tool_summaries(
                    db, app, user, discovered
                )
            logger.info(
                "[ConnectorRuntime] user_id=%s apps=%d cached=%d discovered=%d "
                "failed=%d duration_ms=%.1f",
                user.id,
                len(apps),
                cached_count,
                len(pending)
                - sum(1 for item in outcomes if isinstance(item, BaseException)),
                sum(1 for item in outcomes if isinstance(item, BaseException)),
                (time.monotonic() - started_at) * 1000,
            )
        return tools

    @staticmethod
    async def _discover_tools(db: Session, app: ConnectorApp, user: User) -> list[Any]:
        return await ConnectorRuntimeService._upstream_tools(db, app, user)

    @staticmethod
    def _is_auth_failure(error: BaseException) -> bool:
        return isinstance(error, HTTPException) and error.status_code in {401, 403}

    @staticmethod
    def _visible_tools(
        app: ConnectorApp, upstream_tools: list[Any]
    ) -> list[ConnectorTool]:
        allowlist = set(app.tool_allowlist or [])
        return [
            ConnectorRuntimeService._tool_from_upstream(app, tool)
            for tool in upstream_tools
            if not allowlist or tool.name in allowlist
        ]

    @staticmethod
    def _known_tool_names(db: Session, app: ConnectorApp, user: User) -> set[str]:
        """Upstream tool names the cached surface already contains."""
        connection = connector_connection_service.get(
            db, slug=app.slug, user_id=user.id
        )
        if not connection:
            return set()
        return {
            str(summary.get("rawToolName"))
            for summary in connection.tool_summaries
            if summary.get("rawToolName")
        }

    @staticmethod
    def _cached_input_schema(
        db: Session, app: ConnectorApp, user: User, raw_name: str
    ) -> dict[str, Any] | None:
        """Return the cached input schema for one upstream tool, if known."""
        connection = connector_connection_service.get(
            db, slug=app.slug, user_id=user.id
        )
        if connection is None:
            return None
        for summary in connection.tool_summaries:
            if summary.get("rawToolName") == raw_name:
                schema = summary.get("inputSchema")
                return schema if isinstance(schema, dict) else None
        return None

    @staticmethod
    def _coerce_arguments_to_schema(
        schema: dict[str, Any] | None,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        """Align scalar arguments with the upstream JSON Schema types.

        Models occasionally send ``20`` for a field the upstream declares as a
        string, which the MCP server rejects before the tool runs.
        """
        if not isinstance(schema, dict) or not arguments:
            return arguments
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            return arguments
        coerced = dict(arguments)
        for key, value in arguments.items():
            prop = properties.get(key)
            if not isinstance(prop, dict):
                continue
            expected = prop.get("type")
            if isinstance(expected, list):
                expected = next((item for item in expected if item != "null"), None)
            if expected == "string" and isinstance(value, (int, float, bool)):
                if value is True:
                    coerced[key] = "true"
                elif value is False:
                    coerced[key] = "false"
                else:
                    coerced[key] = str(value)
            elif expected == "integer" and isinstance(value, str):
                try:
                    coerced[key] = int(value.strip())
                except ValueError:
                    continue
            elif expected == "number" and isinstance(value, str):
                try:
                    coerced[key] = float(value.strip())
                except ValueError:
                    continue
            elif expected == "boolean" and isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in {"true", "false"}:
                    coerced[key] = lowered == "true"
        return coerced

    @staticmethod
    def _cached_tools(app: ConnectorApp, connection: Any) -> list[ConnectorTool] | None:
        """Return cached tools when they are still fresh, else ``None``."""
        if connection is None or not connection.tool_summaries:
            return None
        discovered_at = connection.tools_discovered_at
        if discovered_at is None:
            return None
        age = datetime.now(timezone.utc).replace(tzinfo=None) - discovered_at
        if age > timedelta(seconds=TOOL_CACHE_TTL_SECONDS):
            return None
        allowlist = set(app.tool_allowlist or [])
        tools: list[ConnectorTool] = []
        for summary in connection.tool_summaries:
            raw_name = str(summary.get("rawToolName") or "")
            if not raw_name or (allowlist and raw_name not in allowlist):
                continue
            tools.append(
                ConnectorTool(
                    name=str(summary.get("name") or f"{app.slug}__{raw_name}"),
                    title=summary.get("title"),
                    description=str(summary.get("description") or ""),
                    input_schema=summary.get("inputSchema")
                    or {"type": "object", "properties": {}},
                    connector_id=app.slug,
                    connector_slug=app.slug,
                    connector_name=app.name,
                    raw_tool_name=raw_name,
                    source_transport=app.transport or "streamable-http",
                    app_id=app.id,
                    app_slug=app.slug,
                    app_name=app.name,
                )
            )
        return tools

    @staticmethod
    async def refresh_tool_summary_cache(
        db: Session,
        app: ConnectorApp,
        user: User,
    ) -> None:
        """Cache the current tool surface for later expired-connection views."""
        if app.transport == "http":
            app_tools = ConnectorRuntimeService._http_tools(app)
        else:
            config = await ConnectorRuntimeService._server_config(db, app, user)
            async with ConnectorRuntimeService._mcp_session(config) as session:
                upstream_tools = await ConnectorRuntimeService._list_all_tools(session)
            allowlist = set(app.tool_allowlist or [])
            app_tools = [
                ConnectorRuntimeService._tool_from_upstream(app, tool)
                for tool in upstream_tools
                if not allowlist or tool.name in allowlist
            ]
        await ConnectorRuntimeService._cache_tool_summaries(db, app, user, app_tools)

    @staticmethod
    async def _cache_tool_summaries(
        db: Session,
        app: ConnectorApp,
        user: User,
        tools: list[ConnectorTool],
    ) -> None:
        connection = connector_connection_service.get(
            db,
            slug=app.slug,
            user_id=user.id,
        )
        if not connection:
            return
        summaries = [
            {
                "name": tool.name,
                "title": tool.title,
                "description": tool.description,
                "rawToolName": tool.raw_tool_name,
                # Keep the schema so a cached surface can still drive tool calls.
                "inputSchema": tool.input_schema,
            }
            for tool in tools
        ]
        if connection.tool_summaries != summaries:
            connector_connection_service.save_tool_summaries(db, connection, summaries)

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
        db: Session,
        user: User,
        name: str,
        arguments: dict[str, Any],
        *,
        enforce_visibility: bool = True,
    ) -> tuple[Any, dict[str, Any] | None, bool]:
        app_slug, separator, upstream_name = name.partition("__")
        if not separator or not app_slug or not upstream_name:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Invalid connector tool name"
            )
        app = ConnectorAppService.get_app_by_slug(db, app_slug)
        if not app:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector app not found")
        # Administrators testing a catalog app are not necessarily inside its
        # visibility rules, so the admin endpoint opts out of this gate. Every
        # user-facing call keeps it.
        if enforce_visibility:
            visible_ids = {
                item.id for item in ConnectorAppService.list_visible_apps(db, user)
            }
            if app.id not in visible_ids:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "Connector app not found"
                )
        allowlist = set(app.tool_allowlist or [])
        if allowlist and upstream_name not in allowlist:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Connector tool is disabled")
        config = await ConnectorRuntimeService._server_config(db, app, user)
        if app.transport == "http":
            definition = ConnectorRuntimeService._http_tool_definition(
                app, upstream_name
            )
            return await ConnectorRuntimeService._call_http_tool(
                config, definition, arguments
            )
        try:
            schema = ConnectorRuntimeService._cached_input_schema(
                db, app, user, upstream_name
            )
            async with ConnectorRuntimeService._mcp_session(config) as session:
                # The cached surface already proved this tool exists, so skip a
                # full tools/list round trip; only resolve unknown names.
                tool_name = upstream_name
                if upstream_name not in ConnectorRuntimeService._known_tool_names(
                    db, app, user
                ):
                    tool = await ConnectorRuntimeService._find_tool(
                        session, upstream_name
                    )
                    if not tool:
                        raise HTTPException(
                            status.HTTP_404_NOT_FOUND, "Connector tool not found"
                        )
                    tool_name = tool.name
                    schema = (
                        ConnectorRuntimeService._model_dump(
                            getattr(tool, "inputSchema", None)
                        )
                        or schema
                    )
                arguments = ConnectorRuntimeService._coerce_arguments_to_schema(
                    schema, arguments
                )
                result = await session.call_tool(tool_name, arguments)
                return (
                    ConnectorRuntimeService._json_safe(result.content),
                    ConnectorRuntimeService._json_safe(result.structuredContent),
                    bool(result.isError),
                )
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception(
                "Connector tool call failed for app '%s' tool '%s': %s",
                app.slug,
                upstream_name,
                exc,
            )
            if ConnectorRuntimeService._mark_expired_on_auth_error(db, app, user, exc):
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    f"Connector '{app.slug}' requires authorization",
                ) from exc
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                ConnectorRuntimeService._tool_failure_detail(exc),
            ) from exc

    @staticmethod
    def _tool_failure_detail(error: Exception) -> str:
        """Return a safe, actionable summary for an upstream tool failure."""
        text = " ".join(_exception_texts(error)).casefold()
        if "certificate_verify_failed" in text or "self-signed certificate" in text:
            return "Connector upstream TLS certificate verification failed"
        if "timeout" in text or "timed out" in text:
            return "Connector upstream request timed out"
        if "connecterror" in text or "all connection attempts failed" in text:
            return "Connector upstream connection failed"
        return "Connector tool execution failed"

    @staticmethod
    def _mark_expired_on_auth_error(
        db: Session,
        app: ConnectorApp,
        user: User,
        error: Exception,
    ) -> bool:
        """Mark the user's connection expired when the upstream rejected it.

        MCP transports raise through an ``ExceptionGroup``, whose own message
        carries no status code, so the whole exception tree has to be inspected
        before deciding the failure is an authorization problem.
        """
        if app.auth_type == "none":
            return False
        message = " ".join(_exception_texts(error)).lower()
        if not any(
            marker in message for marker in ("401", "403", "unauthorized", "forbidden")
        ):
            return False
        connection = connector_connection_service.get(
            db,
            slug=app.slug,
            user_id=user.id,
        )
        if connection:
            connector_connection_service.set_status(db, connection, "expired")
        return True

    @staticmethod
    def _connected_apps(
        db: Session,
        user: User,
        *,
        app_slug: str | None = None,
    ) -> tuple[list[ConnectorApp], dict[str, Any]]:
        """Return connected apps plus every stored connection in one read."""
        connections = connector_connection_service.list_for_user(db, user_id=user.id)
        connected: list[ConnectorApp] = []
        for app in ConnectorAppService.list_visible_apps(db, user):
            if app_slug:
                if app.slug != app_slug:
                    continue
            elif app.tool_loading_mode != "static":
                # The unscoped surface is the eager `wegent-connectors` MCP.
                # Skill-loaded apps are only reachable through their scoped
                # server after `load_skill` activates the app.
                continue
            if app.auth_type == "none":
                connected.append(app)
                continue
            connection = connections.get(app.slug)
            if connector_connection_service.is_usable(connection):
                # `_server_config` refreshes an expired grant before use.
                connected.append(app)
        return connected, connections

    @staticmethod
    def _http_tools(app: ConnectorApp) -> list[ConnectorTool]:
        allowlist = set(app.tool_allowlist or [])
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
                source_transport=app.transport or "http",
                app_id=app.id,
                app_slug=app.slug,
                app_name=app.name,
            )
            for definition in ConnectorRuntimeService._http_tool_definitions(app)
            if not allowlist or definition.name in allowlist
        ]

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
            source_transport=app.transport or "streamable-http",
            app_id=app.id,
            app_slug=app.slug,
            app_name=app.name,
        )

    @staticmethod
    def _http_tool_definitions(
        app: ConnectorApp,
    ) -> list[ConnectorHttpToolDefinition]:
        try:
            return [
                ConnectorHttpToolDefinition.model_validate(item)
                for item in (app.http_tools or [])
            ]
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Connector HTTP tool configuration is invalid",
            ) from exc

    @staticmethod
    def _http_tool_definition(
        app: ConnectorApp, name: str
    ) -> ConnectorHttpToolDefinition:
        definition = next(
            (
                item
                for item in ConnectorRuntimeService._http_tool_definitions(app)
                if item.name == name
            ),
            None,
        )
        if not definition:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector tool not found")
        return definition

    @staticmethod
    async def _upstream_tools(
        db: Session,
        app: ConnectorApp,
        user: User,
    ) -> list[Any]:
        try:
            config = await ConnectorRuntimeService._server_config(db, app, user)
            async with ConnectorRuntimeService._mcp_session(config) as session:
                return await ConnectorRuntimeService._list_all_tools(session)
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception(
                "Failed to list tools for connector '%s': %s",
                app.slug,
                exc,
            )
            if ConnectorRuntimeService._mark_expired_on_auth_error(db, app, user, exc):
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    f"Connector '{app.slug}' requires authorization",
                ) from exc
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"Failed to list tools for connector '{app.slug}': "
                f"{ConnectorRuntimeService._tool_failure_detail(exc)}",
            ) from exc

    @staticmethod
    @trace_async("connector.runtime.call_http", "backend.connector")
    async def _call_http_tool(
        config: dict[str, Any],
        definition: ConnectorHttpToolDefinition,
        arguments: dict[str, Any],
    ) -> tuple[Any, dict[str, Any] | None, bool]:
        ConnectorRuntimeService._validate_http_arguments(definition, arguments)
        url, query, body = ConnectorRuntimeService._http_request_parts(
            config["url"], definition, arguments
        )
        try:
            async with create_connector_http_client(
                timeout=httpx.Timeout(definition.timeout_seconds),
                follow_redirects=False,
            ) as client:
                request = client.build_request(
                    definition.method,
                    url,
                    headers=config.get("headers") or None,
                    params=query or None,
                    json=body or None,
                )
                response = await client.send(request, stream=True)
                try:
                    content = await ConnectorRuntimeService._bounded_response_body(
                        response
                    )
                finally:
                    await response.aclose()
        except httpx.HTTPError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Connector HTTP request failed",
            ) from exc
        return ConnectorRuntimeService._http_response(
            response.status_code,
            content,
            response.encoding,
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
        status_code: int,
        content: bytes,
        encoding: str | None,
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
    async def _mcp_session(config: dict[str, Any]) -> AsyncIterator[Any]:
        from mcp import ClientSession
        from mcp.client.sse import sse_client
        from mcp.client.streamable_http import streamablehttp_client

        transport = config["type"]
        client_kwargs: dict[str, Any] = {
            "url": config["url"],
            "headers": config.get("headers") or None,
            "timeout": 30,
            "sse_read_timeout": 180,
            "httpx_client_factory": create_connector_http_client,
        }
        client = sse_client if transport == "sse" else streamablehttp_client
        async with client(**client_kwargs) as streams:
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
        db: Session,
        app: ConnectorApp,
        user: User | None = None,
    ) -> dict[str, Any]:
        headers = _decrypt_json(app.provider_headers_encrypted)
        if user and app.auth_type != "none":
            connection = connector_connection_service.get(
                db,
                slug=app.slug,
                user_id=user.id,
            )
            if (
                connection
                and connector_connection_service.response(connection).status
                == "expired"
            ):
                connection = await connector_oauth_service.refresh_connection(
                    db, connection
                )
            if (
                not connection
                or connector_connection_service.response(connection).status
                != "connected"
            ):
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    f"Connector '{app.slug}' requires authorization",
                )
            access_token = connection.access_token()
            if not access_token:
                if connection.access_token_encrypted:
                    # The grant exists but the configured key cannot read it.
                    # Re-authorizing would only paper over an environment
                    # fault, so report it instead of asking for a new grant.
                    # A 5xx also lets the caller record `lastError`, which is
                    # what surfaces the problem in the connection UI.
                    raise HTTPException(
                        status.HTTP_503_SERVICE_UNAVAILABLE,
                        f"Connector '{app.slug}' credential cannot be decrypted: "
                        "GIT_TOKEN_AES_KEY/GIT_TOKEN_AES_IV must match the "
                        "configuration that stored it",
                    )
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    f"Connector '{app.slug}' requires authorization",
                )
            headers["Authorization"] = f"Bearer {access_token}"
        if user:
            headers["X-Wegent-Username"] = user.user_name
            headers["X-Wegent-User-Id"] = str(user.id)
        return {
            "type": app.transport,
            "url": app.mcp_url,
            "headers": headers,
        }

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
