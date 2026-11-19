"""Tool identity remains exact through discovery, cache, and invocation."""

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_connections import connector_connection_service
from app.services.connector_runtime import ConnectorRuntimeService
from shared.utils.connector_tools import qualify_connector_tool

TARGETS = [("reports", "archive__lookup"), ("reports__archive", "lookup")]


@pytest.mark.asyncio
@pytest.mark.parametrize("only_target", [False, True])
async def test_listing_cache_and_calls_do_not_alias_another_app(
    test_db, test_user, test_admin_user, monkeypatch, only_target
) -> None:
    targets = TARGETS[1:] if only_target else TARGETS
    for slug, raw_name in targets:
        connector_app_service.create_app(
            test_db,
            ConnectorAppWrite(
                slug=slug,
                name=slug,
                mcp_url=f"https://upstream.example.test/{slug}",
                auth_type="oauth2",
                tool_allowlist=[raw_name],
            ),
            test_admin_user,
        )
        connector_connection_service.save_oauth_connection(
            test_db,
            slug=slug,
            user_id=test_user.id,
            access_token=f"grant-{slug}",
            refresh_token=None,
            token_type="bearer",
            granted_scopes=[],
            external_account_name=None,
            expires_at=None,
        )
    discoveries = []
    calls = []

    @asynccontextmanager
    async def session(config):
        slug = config["url"].rsplit("/", 1)[-1]
        raw_name = dict(targets)[slug]
        assert config["headers"]["Authorization"] == f"Bearer grant-{slug}"

        async def list_tools(cursor=None):
            discoveries.append(slug)
            return SimpleNamespace(
                tools=[
                    SimpleNamespace(
                        name=raw_name,
                        description=slug,
                        title=None,
                        inputSchema={
                            "type": "object",
                            "properties": {"id": {"type": "string"}},
                        },
                    )
                ],
                nextCursor=None,
            )

        async def call_tool(name, arguments):
            calls.append((slug, name, arguments))
            return SimpleNamespace(
                content=[], structuredContent={"app": slug, "tool": name}, isError=False
            )

        yield SimpleNamespace(list_tools=list_tools, call_tool=call_tool)

    monkeypatch.setattr(ConnectorRuntimeService, "_mcp_session", session)
    first = await ConnectorRuntimeService.list_tools(test_db, test_user)
    assert {tool.name for tool in first} == {
        qualify_connector_tool(*target) for target in targets
    }
    assert sorted(discoveries) == sorted(slug for slug, _ in targets)
    # Corrupt legacy cache names deliberately: identity must come from its owner
    # and rawToolName, including after the ORM reloads the persisted document.
    for slug, raw_name in targets:
        connection = connector_connection_service.get(
            test_db, slug=slug, user_id=test_user.id
        )
        summary = dict(connection.tool_summaries[0])
        summary["name"] = "reports__archive__lookup"
        connector_connection_service.save_tool_summaries(test_db, connection, [summary])
    test_db.expire_all()
    cached = await ConnectorRuntimeService.list_tools(test_db, test_user)
    assert {tool.name for tool in cached} == {
        qualify_connector_tool(*target) for target in targets
    }
    assert len(discoveries) == len(targets)
    assert await ConnectorRuntimeService.list_tools(test_db, test_admin_user) == []
    for slug, raw_name in targets:
        _, structured, is_error = await ConnectorRuntimeService.call_tool(
            test_db, test_user, qualify_connector_tool(slug, raw_name), {"id": "42"}
        )
        assert structured == {"app": slug, "tool": raw_name}
        assert is_error is False
    assert calls == [(slug, raw, {"id": "42"}) for slug, raw in targets]
    with pytest.raises(HTTPException) as failure:
        await ConnectorRuntimeService.call_tool(
            test_db, test_admin_user, qualify_connector_tool(*targets[-1]), {}
        )
    assert failure.value.status_code == 401
    assert len(calls) == len(targets)
