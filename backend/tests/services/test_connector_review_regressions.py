"""Regression coverage for internal generic MCP review findings."""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import HTTPException

from app.core.cache import cache_manager
from app.models.kind import Kind
from app.schemas.connector import ConnectorAppUpdate, ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_connections import connector_connection_service
from app.services.connector_oauth import ConnectorOAuthService, _authorization_url
from app.services.connector_oauth_discovery import discover_connector_oauth
from app.services.connector_runtime import ConnectorRuntimeService

SLUG = "review-app"
RESOURCE = "https://review.example.test/mcp"


def connect(db, user, *, token="account-a", expired=False):
    return connector_connection_service.save_oauth_connection(
        db,
        slug=SLUG,
        user_id=user.id,
        access_token=token,
        refresh_token=f"{token}-refresh",
        token_type="bearer",
        granted_scopes=["mcp.read"],
        external_account_name=token,
        expires_at=(
            datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
            if expired
            else None
        ),
    )


@pytest.fixture
def app(test_db, test_admin_user):
    return connector_app_service.create_app(
        test_db,
        ConnectorAppWrite(
            slug=SLUG, name="Review", auth_type="oauth2", mcp_url=RESOURCE
        ),
        test_admin_user,
    )


@pytest.fixture
def oauth_session(app, monkeypatch):
    sessions = {}

    async def get(key):
        return sessions.get(key)

    async def set_value(key, value, expire):
        sessions[key] = dict(value)
        return True

    async def claim(key, value, expire):
        if key in sessions:
            return False
        sessions[key] = value
        return True

    monkeypatch.setattr(cache_manager, "get", get)
    monkeypatch.setattr(cache_manager, "set", set_value)
    monkeypatch.setattr(cache_manager, "setnx", claim)
    monkeypatch.setattr(
        "app.services.connector_oauth.discover_connector_oauth",
        AsyncMock(
            return_value={
                "resource": RESOURCE,
                "issuer": "https://review.example.test",
                "authorization_endpoint": "https://review.example.test/authorize?tenant=one",
                "token_endpoint": "https://review.example.test/token",
                "scope": "mcp.read",
            }
        ),
    )
    monkeypatch.setattr(
        ConnectorOAuthService,
        "_dynamic_client",
        AsyncMock(return_value={"client_id": "review-client"}),
    )
    monkeypatch.setattr(ConnectorOAuthService, "_cache_authorized_tools", AsyncMock())
    return sessions


def test_reauthorization_and_late_discovery_do_not_reuse_old_account_tools(
    app, test_db, test_user
):
    old = connect(test_db, test_user)
    connector_connection_service.save_tool_summaries(
        test_db, old, [{"name": f"{SLUG}__private", "rawToolName": "private"}]
    )

    new = connect(test_db, test_user, token="account-b")
    assert new.tool_summaries == []
    assert new.tools_discovered_at is None

    connector_connection_service.save_tool_summaries(
        test_db, old, [{"name": f"{SLUG}__stale", "rawToolName": "stale"}]
    )
    connector_connection_service.record_tool_error(test_db, old, "old account failure")
    current = connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
    assert current.access_token() == "account-b"
    assert current.tool_summaries == []
    assert current.last_error is None


@pytest.mark.asyncio
async def test_runtime_discovery_is_bound_to_the_token_used(
    app, test_db, test_user, monkeypatch
):
    connect(test_db, test_user)

    @asynccontextmanager
    async def mcp_session(config):
        assert config["headers"]["Authorization"] == "Bearer account-a"

        async def list_tools(cursor=None):
            connect(test_db, test_user, token="account-b")
            return SimpleNamespace(
                tools=[SimpleNamespace(name="private", inputSchema={"type": "object"})],
                nextCursor=None,
            )

        yield SimpleNamespace(list_tools=list_tools)

    monkeypatch.setattr(ConnectorRuntimeService, "_mcp_session", mcp_session)
    await ConnectorRuntimeService.list_tools(test_db, test_user)

    current = connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
    assert current.access_token() == "account-b"
    assert current.tool_summaries == []


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["accessTokenEncrypted", "refreshTokenEncrypted"])
async def test_expired_unreadable_grant_is_not_missing_authorization(
    app, test_db, test_user, monkeypatch, field
):
    connection = connect(test_db, test_user, expired=True)
    document = dict(connection.row.json)
    document["spec"] = {**document["spec"], field: "unreadable"}
    connection.row.json = document
    test_db.commit()
    stored = connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
    assert connector_connection_service.is_usable(stored)
    upstream = AsyncMock()
    monkeypatch.setattr(ConnectorRuntimeService, "_mcp_session", upstream)

    assert await ConnectorRuntimeService.list_tools(test_db, test_user) == []

    upstream.assert_not_called()
    current = connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
    assert current.status == "connected"
    assert "cannot be decrypted" in current.last_error
    assert current.refresh_token_encrypted == stored.refresh_token_encrypted


@pytest.mark.asyncio
async def test_probe_marks_only_the_rejected_credential_expired(
    app, test_db, test_user, monkeypatch
):
    connect(test_db, test_user)

    @asynccontextmanager
    async def mcp_session(config):
        raise httpx.HTTPStatusError(
            "401 Unauthorized",
            request=httpx.Request("GET", RESOURCE),
            response=httpx.Response(401, request=httpx.Request("GET", RESOURCE)),
        )
        yield

    monkeypatch.setattr(ConnectorRuntimeService, "_mcp_session", mcp_session)
    await ConnectorRuntimeService.probe_app(test_db, app, test_user)

    current = connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
    assert current.status == "expired"
    assert current.refresh_token() == "account-a-refresh"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(400, json={"error": "invalid_client"}),
        httpx.Response(403, text="gateway policy"),
        httpx.Response(200, json={"error": "temporarily_unavailable"}),
        httpx.Response(200, text="not JSON"),
        httpx.Response(200, json=[]),
        httpx.Response(200, json={"token_type": "bearer"}),
    ],
)
async def test_protocol_or_configuration_errors_preserve_the_refresh_grant(
    app, test_db, test_user, monkeypatch, response
):
    connection = connect(test_db, test_user, expired=True)
    monkeypatch.setattr(
        ConnectorOAuthService,
        "_stored_dynamic_client",
        lambda _app: {
            "token_endpoint": "https://review.example.test/token",
            "client_id": "review-client",
        },
    )

    async def send(_client, request, **kwargs):
        response.request = request
        return response

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
    assert await ConnectorOAuthService.refresh_connection(test_db, connection) is None
    current = connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
    assert current.refresh_token() == "account-a-refresh"

    monkeypatch.setattr(
        "app.services.connector_runtime.connector_oauth_service.refresh_connection",
        AsyncMock(return_value=None),
    )
    with pytest.raises(HTTPException) as failure:
        await ConnectorRuntimeService._server_config(test_db, app, test_user)
    assert failure.value.status_code == 503


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["delete", "replace", "disable", "resource"])
async def test_callback_cannot_authorize_a_removed_or_changed_app(
    app, test_db, test_user, test_admin_user, monkeypatch, oauth_session, mutation
):
    session = await ConnectorOAuthService.create_session(
        test_db, slug=SLUG, user_id=test_user.id
    )
    state = parse_qs(urlsplit(session.authorize_url).query)["state"][0]

    async def exchange(**kwargs):
        if mutation in {"delete", "replace"}:
            connector_app_service.delete_app(test_db, app)
            if mutation == "replace":
                connector_app_service.create_app(
                    test_db,
                    ConnectorAppWrite(
                        slug=SLUG,
                        name="Replacement",
                        auth_type="oauth2",
                        mcp_url=RESOURCE,
                    ),
                    test_admin_user,
                )
        else:
            update = (
                {"enabled": False}
                if mutation == "disable"
                else {"mcp_url": "https://replacement.example.test/mcp"}
            )
            connector_app_service.update_app(test_db, app, ConnectorAppUpdate(**update))
        return {"access_token": "late-token", "refresh_token": "late-refresh"}

    monkeypatch.setattr(ConnectorOAuthService, "_exchange_dynamic_code", exchange)
    with pytest.raises(HTTPException) as failure:
        await ConnectorOAuthService.complete_callback(
            test_db, code="code", state_token=state
        )
    assert failure.value.status_code in {404, 409}
    assert (
        connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
        is None
    )


@pytest.mark.asyncio
async def test_callback_is_single_use_but_successful_poll_is_idempotent(
    app, test_db, test_user, monkeypatch, oauth_session
):
    session = await ConnectorOAuthService.create_session(
        test_db, slug=SLUG, user_id=test_user.id
    )
    state = parse_qs(urlsplit(session.authorize_url).query)["state"][0]
    entered = asyncio.Event()
    release = asyncio.Event()

    async def exchange(**kwargs):
        entered.set()
        await release.wait()
        return {"access_token": "authorized", "refresh_token": "refresh"}

    exchange_mock = AsyncMock(side_effect=exchange)
    monkeypatch.setattr(ConnectorOAuthService, "_exchange_dynamic_code", exchange_mock)
    first = asyncio.create_task(
        ConnectorOAuthService.complete_callback(test_db, code="code", state_token=state)
    )
    await entered.wait()
    try:
        with pytest.raises(HTTPException) as failure:
            await ConnectorOAuthService.complete_callback(
                test_db, code="code", state_token=state
            )
        assert failure.value.status_code == 409
    finally:
        release.set()
        await first
    assert exchange_mock.await_count == 1
    for _ in range(2):
        result = await ConnectorOAuthService.poll_session(
            test_db,
            session_id=session.session_id,
            poll_token=session.poll_token,
            user_id=test_user.id,
        )
        assert result.status == "success"
        assert result.connection.status == "connected"


def test_changing_upstream_removes_the_old_resource_grants(app, test_db, test_user):
    connect(test_db, test_user)
    updated = connector_app_service.update_app(
        test_db, app, ConnectorAppUpdate(mcp_url="https://replacement.example.test/mcp")
    )
    assert updated.oauth_client_encrypted is None
    assert (
        connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
        is None
    )


def test_admin_lookup_does_not_select_a_foreign_owner(test_db, test_user):
    row = Kind(
        kind="ConnectorApp",
        namespace="system",
        name=SLUG,
        user_id=test_user.id,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add(row)
    test_db.commit()
    with pytest.raises(HTTPException) as failure:
        connector_app_service.get_app(test_db, row.id)
    assert failure.value.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", ["resource", "issuer"])
async def test_discovery_rejects_mismatched_metadata(monkeypatch, mismatch):
    async def send(_client, request, **kwargs):
        if request.url.path == "/mcp":
            return httpx.Response(401, request=request)
        if "oauth-protected-resource" in request.url.path:
            payload = {
                "resource": RESOURCE,
                "authorization_servers": ["https://review.example.test"],
            }
            if mismatch == "resource":
                payload["resource"] = "https://review.example.test/other"
        else:
            payload = {
                "issuer": "https://review.example.test",
                "authorization_endpoint": "https://review.example.test/authorize",
                "token_endpoint": "https://review.example.test/token",
            }
            if mismatch == "issuer":
                payload["issuer"] = "https://different.example.test"
        return httpx.Response(200, json=payload, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
    with pytest.raises(HTTPException) as failure:
        await discover_connector_oauth(RESOURCE)
    assert failure.value.status_code == 502


def test_authorization_url_preserves_existing_query_and_overwrites_flow_fields():
    url = _authorization_url(
        "https://review.example.test/authorize?tenant=one&state=old",
        {"state": "new", "code_challenge": "pkce"},
    )
    assert parse_qs(urlsplit(url).query) == {
        "tenant": ["one"],
        "state": ["new"],
        "code_challenge": ["pkce"],
    }


def test_connection_timestamps_are_normalized_to_utc(app, test_db, test_user):
    connection = connect(test_db, test_user)
    payload = dict(connection.row.json)
    payload["spec"] = {
        **payload["spec"],
        "expiresAt": "2026-11-05T12:00:00+08:00",
        "toolsDiscoveredAt": "2026-11-05T12:00:00+08:00",
    }
    connection.row.json = payload
    test_db.commit()
    current = connector_connection_service.get(test_db, slug=SLUG, user_id=test_user.id)
    assert current.expires_at == datetime(2026, 11, 5, 4)
    assert current.tools_discovered_at == datetime(2026, 11, 5, 4)
