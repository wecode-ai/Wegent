# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The connector MCP surface must follow the caller's visible, allowed tools."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.mcp_server import connectors_app


@pytest.mark.asyncio
async def test_list_tools_returns_only_the_callers_tools(monkeypatch) -> None:
    monkeypatch.setattr(connectors_app, "current_connector_user_id", lambda: 7)
    monkeypatch.setattr(
        connectors_app,
        "_active_user",
        lambda db, user_id: SimpleNamespace(
            id=user_id, user_name="alice", is_active=True
        ),
    )
    tools = [
        SimpleNamespace(
            name="dingtalk__list_bases",
            title="List bases",
            description="List bases",
            input_schema={"type": "object", "properties": {}},
        )
    ]
    list_tools = AsyncMock(return_value=tools)
    monkeypatch.setattr(
        connectors_app.connector_runtime_service, "list_tools", list_tools
    )

    result = await connectors_app.list_connector_tools()

    assert [tool.name for tool in result] == ["dingtalk__list_bases"]
    assert result[0].inputSchema == {"type": "object", "properties": {}}
    assert list_tools.await_args.args[1].id == 7


@pytest.mark.asyncio
async def test_list_tools_is_empty_without_a_user(monkeypatch) -> None:
    monkeypatch.setattr(connectors_app, "current_connector_user_id", lambda: None)

    assert await connectors_app.list_connector_tools() == []


@pytest.mark.asyncio
async def test_list_tools_passes_the_scoped_app_slug(monkeypatch) -> None:
    monkeypatch.setattr(connectors_app, "current_connector_user_id", lambda: 7)
    monkeypatch.setattr(
        connectors_app,
        "_active_user",
        lambda db, user_id: SimpleNamespace(
            id=user_id, user_name="alice", is_active=True
        ),
    )
    list_tools = AsyncMock(return_value=[])
    monkeypatch.setattr(
        connectors_app.connector_runtime_service, "list_tools", list_tools
    )
    token = connectors_app.connector_mcp_app_slug.set("dingtalk")
    try:
        await connectors_app.list_connector_tools()
    finally:
        connectors_app.connector_mcp_app_slug.reset(token)

    assert list_tools.await_args.kwargs["app_slug"] == "dingtalk"


@pytest.mark.asyncio
async def test_call_tool_returns_content_and_error_state(monkeypatch) -> None:
    monkeypatch.setattr(connectors_app, "current_connector_user_id", lambda: 7)
    monkeypatch.setattr(
        connectors_app,
        "_active_user",
        lambda db, user_id: SimpleNamespace(
            id=user_id, user_name="alice", is_active=True
        ),
    )
    call_tool = AsyncMock(
        return_value=(
            [{"type": "text", "text": "bases: 2"}],
            {"count": 2},
            True,
        )
    )
    monkeypatch.setattr(
        connectors_app.connector_runtime_service, "call_tool", call_tool
    )

    result = await connectors_app.call_connector_tool("dingtalk__list_bases", {})

    assert result.content[0].text == "bases: 2"
    assert result.structuredContent == {"count": 2}
    assert result.isError is True


@pytest.mark.asyncio
async def test_call_tool_surfaces_authorization_detail(monkeypatch) -> None:
    monkeypatch.setattr(connectors_app, "current_connector_user_id", lambda: 7)
    monkeypatch.setattr(
        connectors_app,
        "_active_user",
        lambda db, user_id: SimpleNamespace(
            id=user_id, user_name="alice", is_active=True
        ),
    )
    monkeypatch.setattr(
        connectors_app.connector_runtime_service,
        "call_tool",
        AsyncMock(
            side_effect=HTTPException(
                401, "Connector 'dingtalk' requires authorization"
            )
        ),
    )

    result = await connectors_app.call_connector_tool("dingtalk__list_bases", {})

    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["error"] == "connector_auth_required"
    assert payload["connectorSlug"] == "dingtalk"


@pytest.mark.asyncio
async def test_call_tool_rejects_a_tool_outside_the_scoped_app(monkeypatch) -> None:
    monkeypatch.setattr(connectors_app, "current_connector_user_id", lambda: 7)
    monkeypatch.setattr(
        connectors_app,
        "_active_user",
        lambda db, user_id: SimpleNamespace(
            id=user_id, user_name="alice", is_active=True
        ),
    )
    call_tool = AsyncMock()
    monkeypatch.setattr(
        connectors_app.connector_runtime_service, "call_tool", call_tool
    )
    token = connectors_app.connector_mcp_app_slug.set("dingtalk")
    try:
        result = await connectors_app.call_connector_tool("other__search", {})
    finally:
        connectors_app.connector_mcp_app_slug.reset(token)

    assert result.isError is True
    assert "outside this Skill's app scope" in result.content[0].text
    call_tool.assert_not_awaited()
