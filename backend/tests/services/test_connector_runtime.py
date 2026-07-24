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

from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import _encrypt_json, connector_app_service
from app.services.connector_runtime import ConnectorRuntimeService


def _app(**overrides):
    defaults = {
        "id": 1,
        "slug": "app",
        "name": "App",
        "description": "",
        "enabled": True,
        "visibility": "all",
        "allowed_roles": [],
        "auth_type": "none",
        "transport": "streamable-http",
        "mcp_url": "https://mcp.example.test/app",
        "provider_headers_encrypted": None,
        "tool_allowlist": [],
        "http_tools": [],
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _create_app(
    db: Session,
    admin: User,
    *,
    slug: str,
    name: str,
    transport: str = "streamable-http",
    tool_allowlist: list[str] | None = None,
    http_tools: list[dict] | None = None,
):
    return connector_app_service.create_app(
        db,
        ConnectorAppWrite(
            slug=slug,
            name=name,
            transport=transport,
            mcp_url=f"https://mcp.example.test/{slug}",
            tool_allowlist=tool_allowlist or [],
            http_tools=http_tools or [],
        ),
        admin,
    )


def test_json_safe_serializes_model_values() -> None:
    class Result:
        def model_dump(self, mode: str, by_alias: bool, exclude_none: bool):
            assert mode == "json"
            assert by_alias is True
            assert exclude_none is True
            return {"items": (1, "two")}

    assert ConnectorRuntimeService._json_safe(Result()) == {"items": [1, "two"]}


@pytest.mark.asyncio
async def test_lists_only_allowlisted_tools_with_connector_namespace(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_app(
        test_db,
        test_admin_user,
        slug="crm",
        name="CRM",
        tool_allowlist=["search"],
    )

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
    assert upstream_tools.await_args.args[0] is test_db
    assert upstream_tools.await_args.args[1].slug == "crm"
    assert upstream_tools.await_args.args[2] is test_user


@pytest.mark.asyncio
async def test_tool_discovery_isolates_an_unavailable_app(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unavailable = _app(id=1, slug="offline", name="Offline")
    healthy = _app(id=2, slug="docs", name="Docs")
    user = SimpleNamespace(id=7)

    class Tool:
        name = "search"
        title = "Search"
        description = "Search docs"
        inputSchema = {"type": "object", "properties": {}}
        annotations = None

    async def upstream_tools(_db, app, _user):
        if app.slug == "offline":
            raise HTTPException(502, "upstream unavailable")
        return [Tool()]

    monkeypatch.setattr(
        ConnectorRuntimeService,
        "_connected_apps",
        lambda _db, _user: [unavailable, healthy],
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
async def test_server_config_sends_trusted_user_headers(test_user: User) -> None:
    app = _app(
        slug="sites",
        name="Sites",
        provider_headers_encrypted=_encrypt_json({"X-Provider": "configured"}),
    )

    config = await ConnectorRuntimeService._server_config(app, test_user)

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
    _create_app(
        test_db,
        test_admin_user,
        slug="tickets",
        name="Tickets",
        tool_allowlist=["search"],
    )
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
    _create_app(
        test_db,
        test_admin_user,
        slug="tickets",
        name="Tickets",
        tool_allowlist=["search"],
    )

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
    _create_app(
        test_db,
        test_admin_user,
        slug="ticket-api",
        name="Ticket API",
        transport="http",
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
    )

    async def send(
        _client: httpx.AsyncClient,
        request: httpx.Request,
        *,
        stream: bool,
    ) -> httpx.Response:
        assert stream is True
        assert request.method == "GET"
        assert str(request.url) == (
            "https://mcp.example.test/ticket-api/tickets/T%2F42?expand=true"
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
        _app(
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
