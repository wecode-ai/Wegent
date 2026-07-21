# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connector import ConnectorApp, ConnectorConnection
from app.models.user import User
from app.services.connector_apps import _encrypt_json, _token_expiry
from app.services.connector_runtime import ConnectorRuntimeService


def test_json_safe_serializes_model_values() -> None:
    class Result:
        def model_dump(self, mode: str, by_alias: bool, exclude_none: bool):
            assert mode == "json"
            assert by_alias is True
            assert exclude_none is True
            return {"items": (1, "two")}

    assert ConnectorRuntimeService._json_safe(Result()) == {"items": [1, "two"]}


def test_oauth_expiry_accepts_numeric_string() -> None:
    expiry = _token_expiry("3600")

    assert expiry is not None


@pytest.mark.asyncio
async def test_lists_only_allowlisted_tools_with_connector_namespace(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = ConnectorApp(
        slug="crm",
        name="CRM",
        description="",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="none",
        transport="streamable-http",
        mcp_url="https://mcp.example.test/crm",
        oauth_scopes=[],
        tool_allowlist=["search"],
        created_by=test_admin_user.id,
    )
    test_db.add(app)
    test_db.commit()

    class Tool:
        name = "search"
        title = "Search"
        description = "Search CRM"
        inputSchema = {"type": "object", "properties": {}}
        annotations = {"readOnlyHint": True}

    upstream_tools = AsyncMock(return_value=[Tool()])
    monkeypatch.setattr(ConnectorRuntimeService, "_upstream_tools", upstream_tools)

    tools = await ConnectorRuntimeService.list_tools(test_db, test_user)

    assert [tool.name for tool in tools] == ["crm__search"]
    assert tools[0].annotations == {"readOnlyHint": True}
    upstream_tools.assert_awaited_once_with(test_db, app, None, test_user)


@pytest.mark.asyncio
async def test_tool_discovery_isolates_an_unavailable_app(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unavailable = ConnectorApp(id=1, slug="offline", name="Offline", tool_allowlist=[])
    healthy = ConnectorApp(id=2, slug="docs", name="Docs", tool_allowlist=[])
    connection = ConnectorConnection(status="connected")
    user = SimpleNamespace(id=7)

    class Tool:
        name = "search"
        title = "Search"
        description = "Search docs"
        inputSchema = {"type": "object", "properties": {}}
        annotations = None

    async def upstream_tools(_db, app, _connection, _user):
        if app.slug == "offline":
            raise HTTPException(502, "upstream unavailable")
        return [Tool()]

    monkeypatch.setattr(
        ConnectorRuntimeService,
        "_connected_apps",
        lambda _db, _user: [(unavailable, connection), (healthy, connection)],
    )
    monkeypatch.setattr(
        ConnectorRuntimeService,
        "_upstream_tools",
        upstream_tools,
    )

    tools = await ConnectorRuntimeService.list_tools(object(), user)

    assert [tool.name for tool in tools] == ["docs__search"]


@pytest.mark.asyncio
async def test_lists_every_upstream_tool_page() -> None:
    first = SimpleNamespace(name="first")
    second = SimpleNamespace(name="second")
    session = SimpleNamespace(
        list_tools=AsyncMock(
            side_effect=[
                SimpleNamespace(tools=[first], nextCursor="page-2"),
                SimpleNamespace(tools=[second], nextCursor=None),
            ]
        )
    )

    tools = await ConnectorRuntimeService._list_all_tools(session)

    assert tools == [first, second]
    assert session.list_tools.await_args_list[0].kwargs == {"cursor": None}
    assert session.list_tools.await_args_list[1].kwargs == {"cursor": "page-2"}


@pytest.mark.asyncio
async def test_rejects_repeated_upstream_tool_cursor() -> None:
    session = SimpleNamespace(
        list_tools=AsyncMock(
            side_effect=[
                SimpleNamespace(tools=[], nextCursor="page-2"),
                SimpleNamespace(tools=[], nextCursor="page-2"),
            ]
        )
    )

    with pytest.raises(RuntimeError, match="repeated cursor"):
        await ConnectorRuntimeService._list_all_tools(session)


@pytest.mark.asyncio
async def test_mcp_session_initializes_streamable_http_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import mcp
    from mcp.client import streamable_http

    observed: dict[str, object] = {}

    @asynccontextmanager
    async def fake_transport(**kwargs):
        observed["transport"] = kwargs
        yield ("read-stream", "write-stream", lambda: None)

    class FakeClientSession:
        def __init__(self, read_stream, write_stream, read_timeout_seconds):
            observed["session"] = (
                read_stream,
                write_stream,
                read_timeout_seconds.total_seconds(),
            )

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def initialize(self):
            observed["initialized"] = True

    monkeypatch.setattr(streamable_http, "streamablehttp_client", fake_transport)
    monkeypatch.setattr(mcp, "ClientSession", FakeClientSession)

    async with ConnectorRuntimeService._mcp_session(
        {
            "type": "streamable-http",
            "url": "https://mcp.example.test/tools",
            "headers": {"Authorization": "Bearer secret"},
        }
    ):
        pass

    assert observed["transport"] == {
        "url": "https://mcp.example.test/tools",
        "headers": {"Authorization": "Bearer secret"},
        "timeout": 30,
        "sse_read_timeout": 180,
    }
    assert observed["session"] == ("read-stream", "write-stream", 180.0)
    assert observed["initialized"] is True


@pytest.mark.asyncio
async def test_server_config_sends_trusted_user_headers(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
) -> None:
    app = ConnectorApp(
        slug="sites",
        name="Sites",
        description="",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="none",
        transport="streamable-http",
        mcp_url="https://mcp.example.test/sites",
        oauth_scopes=[],
        tool_allowlist=[],
        provider_headers_encrypted=_encrypt_json({"X-Provider": "configured"}),
        created_by=test_admin_user.id,
    )

    config = await ConnectorRuntimeService._server_config(test_db, app, None, test_user)

    assert config["headers"] == {
        "X-Provider": "configured",
        "X-Wegent-Username": test_user.user_name,
        "X-Wegent-User-Id": str(test_user.id),
    }


@pytest.mark.asyncio
async def test_call_preserves_mcp_content_and_error_state(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = ConnectorApp(
        slug="tickets",
        name="Tickets",
        description="",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="none",
        transport="streamable-http",
        mcp_url="https://mcp.example.test/tickets",
        oauth_scopes=[],
        tool_allowlist=["search"],
        created_by=test_admin_user.id,
    )
    test_db.add(app)
    test_db.commit()

    tool = SimpleNamespace(name="search")

    class ContentBlock:
        def model_dump(self, mode: str, by_alias: bool, exclude_none: bool):
            assert mode == "json"
            assert by_alias is True
            assert exclude_none is True
            return {"type": "resource_link", "uri": "https://example.test/T-1"}

    session = SimpleNamespace(
        list_tools=AsyncMock(
            return_value=SimpleNamespace(tools=[tool], nextCursor=None)
        ),
        call_tool=AsyncMock(
            return_value=SimpleNamespace(
                content=[ContentBlock()],
                structuredContent={"ticket": {"id": "T-1"}},
                isError=True,
            )
        ),
    )

    @asynccontextmanager
    async def fake_session(_: dict):
        yield session

    monkeypatch.setattr(ConnectorRuntimeService, "_mcp_session", fake_session)

    content, structured_content, is_error = await ConnectorRuntimeService.call_tool(
        test_db, test_user, "tickets__search", {"query": "T-1"}
    )

    assert content == [{"type": "resource_link", "uri": "https://example.test/T-1"}]
    assert structured_content == {"ticket": {"id": "T-1"}}
    assert is_error is True
    session.call_tool.assert_awaited_once_with("search", {"query": "T-1"})


@pytest.mark.asyncio
async def test_rejects_direct_calls_outside_tool_allowlist(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
) -> None:
    app = ConnectorApp(
        slug="tickets",
        name="Tickets",
        description="",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="none",
        transport="streamable-http",
        mcp_url="https://mcp.example.test/tickets",
        oauth_scopes=[],
        tool_allowlist=["search"],
        created_by=test_admin_user.id,
    )
    test_db.add(app)
    test_db.flush()
    test_db.add(
        ConnectorConnection(
            user_id=test_user.id,
            app_id=app.id,
            status="connected",
        )
    )
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        await ConnectorRuntimeService.call_tool(
            test_db, test_user, "tickets__delete", {}
        )

    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_http_connector_lists_and_calls_configured_tool(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = ConnectorApp(
        slug="ticket-api",
        name="Ticket API",
        description="",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="none",
        transport="http",
        mcp_url="https://tickets.example.test/api",
        oauth_scopes=[],
        tool_allowlist=["get_ticket"],
        http_tools=[
            {
                "name": "get_ticket",
                "description": "Get a ticket",
                "method": "GET",
                "path": "/tickets/{id}",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "expand": {"type": "boolean"},
                    },
                    "required": ["id"],
                },
                "argument_locations": {"id": "path", "expand": "query"},
                "timeout_seconds": 15,
            },
            {
                "name": "delete_ticket",
                "method": "DELETE",
                "path": "/tickets/{id}",
                "input_schema": {
                    "type": "object",
                    "properties": {"id": {"type": "string"}},
                    "required": ["id"],
                },
                "argument_locations": {"id": "path"},
            },
        ],
        created_by=test_admin_user.id,
    )
    test_db.add(app)
    test_db.commit()

    async def send(
        _client: httpx.AsyncClient,
        request: httpx.Request,
        *,
        stream: bool,
    ) -> httpx.Response:
        assert stream is True
        assert request.method == "GET"
        assert str(request.url) == (
            "https://tickets.example.test/api/tickets/T%2F42?expand=true"
        )
        assert request.content == b""
        return httpx.Response(
            200,
            json={"id": "T/42", "title": "HTTP adapter works"},
            request=request,
        )

    monkeypatch.setattr(httpx.AsyncClient, "send", send)

    tools = await ConnectorRuntimeService.list_tools(test_db, test_user)
    content, structured, is_error = await ConnectorRuntimeService.call_tool(
        test_db,
        test_user,
        "ticket-api__get_ticket",
        {"id": "T/42", "expand": True},
    )

    assert [tool.name for tool in tools] == ["ticket-api__get_ticket"]
    assert content[0]["type"] == "text"
    assert structured == {
        "status_code": 200,
        "data": {"id": "T/42", "title": "HTTP adapter works"},
    }
    assert is_error is False


@pytest.mark.asyncio
async def test_http_connector_validates_arguments_before_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    definition = ConnectorRuntimeService._http_tool_definition(
        ConnectorApp(
            http_tools=[
                {
                    "name": "lookup",
                    "method": "GET",
                    "path": "/lookup",
                    "input_schema": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                }
            ]
        ),
        "lookup",
    )
    send = AsyncMock()
    monkeypatch.setattr(httpx.AsyncClient, "send", send)

    with pytest.raises(HTTPException) as exc_info:
        await ConnectorRuntimeService._call_http_tool(
            {"url": "https://search.example.test", "headers": {}},
            definition,
            {"query": 42},
        )

    assert exc_info.value.status_code == 422
    send.assert_not_awaited()
