# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for user-level provider MCP OAuth."""

import json
import logging
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
from app.services.user_mcp_oauth import UserMcpOAuthService, user_mcp_oauth_service
from app.services.user_mcp_service import (
    MCP_AUTH_MODE_OAUTH,
    MCP_AUTH_MODE_URL,
    user_mcp_service,
)

RESOURCE_URL = "https://mcp-gw.dingtalk.com/oauth/server/aitable"
REGISTRATION_URL = "https://mcp-gw2.dingtalk.com/oauth/register"
TOKEN_URL = "https://mcp-gw2.dingtalk.com/oauth/token"
AUTHORIZE_URL = "https://mcp-gw2.dingtalk.com/oauth/authorize"


def _metadata() -> dict:
    return {
        "resource": RESOURCE_URL,
        "issuer": "https://mcp-gw2.dingtalk.com",
        "authorization_endpoint": AUTHORIZE_URL,
        "token_endpoint": TOKEN_URL,
        "registration_endpoint": REGISTRATION_URL,
        "scope": "user",
    }


def _configure_oauth_service(db: Session, user: User) -> None:
    updated = user_mcp_service.set_provider_service_config(
        user.preferences,
        provider_id="dingtalk",
        service_id="ai_table",
        enabled=True,
        url=RESOURCE_URL,
        auth_mode=MCP_AUTH_MODE_OAUTH,
    )
    user.preferences = user_mcp_service.dump_preferences(updated)
    db.add(user)
    db.commit()
    db.refresh(user)


def _memory_cache(monkeypatch: pytest.MonkeyPatch) -> dict:
    sessions: dict = {}

    async def cache_set(key: str, value: dict, expire: int) -> bool:
        assert expire > 0
        sessions[key] = dict(value)
        return True

    async def cache_get(key: str):
        value = sessions.get(key)
        return dict(value) if value else None

    monkeypatch.setattr(cache_manager, "set", cache_set)
    monkeypatch.setattr(cache_manager, "get", cache_get)
    return sessions


@pytest.mark.asyncio
async def test_discover_reads_protected_resource_and_authorization_server(
    httpx_mock,
) -> None:
    """Discovery follows RFC 9728 metadata from the 401 challenge."""
    httpx_mock.add_response(
        url=RESOURCE_URL,
        status_code=401,
        headers={
            "www-authenticate": (
                'Bearer realm="mcp", resource_metadata='
                f'"{RESOURCE_URL.replace("/oauth/server/aitable", "")}'
                '/.well-known/oauth-protected-resource/oauth/server/aitable"'
            )
        },
    )
    httpx_mock.add_response(
        url=(
            "https://mcp-gw.dingtalk.com/.well-known/oauth-protected-resource"
            "/oauth/server/aitable"
        ),
        json={
            "resource": RESOURCE_URL,
            "authorization_servers": ["https://mcp-gw2.dingtalk.com"],
            "scopes_supported": ["user"],
            "bearer_methods_supported": ["header"],
        },
    )
    httpx_mock.add_response(
        url="https://mcp-gw2.dingtalk.com/.well-known/oauth-authorization-server",
        json={
            "issuer": "https://mcp-gw2.dingtalk.com",
            "authorization_endpoint": AUTHORIZE_URL,
            "token_endpoint": TOKEN_URL,
            "registration_endpoint": REGISTRATION_URL,
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["user"],
        },
    )

    metadata = await UserMcpOAuthService.discover(RESOURCE_URL)

    assert metadata["issuer"] == "https://mcp-gw2.dingtalk.com"
    assert metadata["token_endpoint"] == TOKEN_URL
    assert metadata["scope"] == "user"


@pytest.mark.asyncio
async def test_authorization_names_the_protected_resource(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    """The RFC 8707 resource indicator is sent on authorize and token requests."""
    _memory_cache(monkeypatch)
    monkeypatch.setattr(settings, "MCP_OAUTH_STATE_SECRET", "state-key")
    _configure_oauth_service(test_db, test_user)
    monkeypatch.setattr(
        UserMcpOAuthService, "discover", AsyncMock(return_value=_metadata())
    )
    httpx_mock.add_response(
        url=REGISTRATION_URL,
        method="POST",
        status_code=201,
        json={"client_id": "dingtalk-client"},
    )
    httpx_mock.add_response(
        url=TOKEN_URL,
        method="POST",
        json={
            "access_token": "dingtalk-access",
            "refresh_token": "dingtalk-refresh",
            "expires_in": 3600,
            "scope": "user",
        },
    )

    session = await user_mcp_oauth_service.create_session(
        test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
    )
    query = parse_qs(urlsplit(session["authorize_url"]).query)
    assert query["resource"] == [RESOURCE_URL]

    await user_mcp_oauth_service.complete_callback(
        test_db,
        code="provider-code",
        state_token=query["state"][0],
        browser_binding=f"{session['session_id']}.{session['binding']}",
    )

    token_request = httpx_mock.get_requests(url=TOKEN_URL)[0]
    assert parse_qs(token_request.content.decode())["resource"] == [RESOURCE_URL]


@pytest.mark.asyncio
async def test_oauth_session_registers_client_and_stores_encrypted_tokens(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    """A completed authorization stores encrypted tokens and flips the auth mode."""
    _memory_cache(monkeypatch)
    monkeypatch.setattr(settings, "MCP_OAUTH_STATE_SECRET", "state-key")
    _configure_oauth_service(test_db, test_user)

    monkeypatch.setattr(
        UserMcpOAuthService, "discover", AsyncMock(return_value=_metadata())
    )
    httpx_mock.add_response(
        url=REGISTRATION_URL,
        method="POST",
        status_code=201,
        json={"client_id": "dingtalk-client"},
    )
    monkeypatch.setattr(
        UserMcpOAuthService,
        "_exchange_code",
        AsyncMock(
            return_value={
                "access_token": "dingtalk-access",
                "refresh_token": "dingtalk-refresh",
                "expires_in": 3600,
                "scope": "user",
            }
        ),
    )

    session = await user_mcp_oauth_service.create_session(
        test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
    )
    query = parse_qs(urlsplit(session["authorize_url"]).query)
    assert query["client_id"] == ["dingtalk-client"]
    assert query["code_challenge_method"] == ["S256"]

    message = await user_mcp_oauth_service.complete_callback(
        test_db,
        code="provider-code",
        state_token=query["state"][0],
        browser_binding=f"{session['session_id']}.{session['binding']}",
    )
    result = await user_mcp_oauth_service.poll_session(
        test_db,
        user=test_user,
        provider_id="dingtalk",
        service_id="ai_table",
        session_id=session["session_id"],
        poll_token=session["poll_token"],
    )

    assert message.startswith("Connected")
    assert result["status"] == "success"
    credentials = user_mcp_service.get_service_oauth_credentials(
        test_user.preferences, "dingtalk", "ai_table"
    )
    assert credentials["access_token"] == "dingtalk-access"
    assert credentials["refresh_token"] == "dingtalk-refresh"
    assert credentials["expires_at"] > 0

    stored = json.loads(test_user.preferences)["mcps"]["dingtalk"]["services"][
        "ai_table"
    ]["credentials"]
    assert stored["access_token"] != "dingtalk-access"
    assert stored["refresh_token"] != "dingtalk-refresh"


@pytest.mark.asyncio
async def test_callback_requires_the_originating_browser(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    """A forwarded authorization URL cannot be completed by another browser."""
    _memory_cache(monkeypatch)
    monkeypatch.setattr(settings, "MCP_OAUTH_STATE_SECRET", "state-key")
    _configure_oauth_service(test_db, test_user)
    monkeypatch.setattr(
        UserMcpOAuthService, "discover", AsyncMock(return_value=_metadata())
    )
    httpx_mock.add_response(
        url=REGISTRATION_URL,
        method="POST",
        status_code=201,
        json={"client_id": "dingtalk-client"},
    )
    monkeypatch.setattr(
        UserMcpOAuthService, "_exchange_code", AsyncMock(return_value={})
    )

    session = await user_mcp_oauth_service.create_session(
        test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
    )
    state = parse_qs(urlsplit(session["authorize_url"]).query)["state"][0]

    for binding in (None, f"{session['session_id']}.wrong-binding"):
        with pytest.raises(HTTPException) as exc_info:
            await user_mcp_oauth_service.complete_callback(
                test_db,
                code="provider-code",
                state_token=state,
                browser_binding=binding,
            )
        assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_oauth_poll_is_scoped_to_the_authorizing_user(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    """Another user cannot poll someone else's authorization session."""
    _memory_cache(monkeypatch)
    monkeypatch.setattr(settings, "MCP_OAUTH_STATE_SECRET", "state-key")
    _configure_oauth_service(test_db, test_user)
    monkeypatch.setattr(
        UserMcpOAuthService, "discover", AsyncMock(return_value=_metadata())
    )
    httpx_mock.add_response(
        url=REGISTRATION_URL,
        method="POST",
        status_code=201,
        json={"client_id": "dingtalk-client"},
    )

    session = await user_mcp_oauth_service.create_session(
        test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
    )

    with pytest.raises(HTTPException) as exc_info:
        await user_mcp_oauth_service.poll_session(
            test_db,
            user=SimpleNamespace(id=test_user.id + 1, preferences="{}"),
            provider_id="dingtalk",
            service_id="ai_table",
            session_id=session["session_id"],
            poll_token=session["poll_token"],
        )

    assert exc_info.value.status_code == 401


def test_settings_put_switching_to_url_mode_clears_oauth_tokens(
    test_db: Session, test_user: User
) -> None:
    """The settings PUT path also drops OAuth credentials on a mode switch."""
    _configure_oauth_service(test_db, test_user)
    saved = user_mcp_service.save_service_oauth_credentials(
        test_user.preferences,
        "dingtalk",
        "ai_table",
        access_token="access",
        refresh_token="refresh",
        expires_at=123,
    )

    updated = user_mcp_service.set_provider_service_config(
        user_mcp_service.dump_preferences(saved),
        provider_id="dingtalk",
        service_id="ai_table",
        enabled=True,
        url=RESOURCE_URL,
        auth_mode=MCP_AUTH_MODE_URL,
    )

    credentials = user_mcp_service.get_service_oauth_credentials(
        user_mcp_service.dump_preferences(updated), "dingtalk", "ai_table"
    )
    assert credentials["access_token"] == ""
    assert credentials["refresh_token"] == ""


def test_url_mode_clears_stored_oauth_tokens(test_db: Session, test_user: User) -> None:
    """Switching back to a personal URL drops OAuth credentials."""
    _configure_oauth_service(test_db, test_user)
    saved = user_mcp_service.save_service_oauth_credentials(
        test_user.preferences,
        "dingtalk",
        "ai_table",
        access_token="access",
        refresh_token="refresh",
        expires_at=123,
    )
    test_user.preferences = user_mcp_service.dump_preferences(saved)

    updated = user_mcp_service.set_service_auth_mode(
        test_user.preferences, "dingtalk", "ai_table", MCP_AUTH_MODE_URL
    )
    test_user.preferences = user_mcp_service.dump_preferences(updated)

    credentials = user_mcp_service.get_service_oauth_credentials(
        test_user.preferences, "dingtalk", "ai_table"
    )
    assert credentials["access_token"] == ""
    assert credentials["refresh_token"] == ""
    assert (
        user_mcp_service.get_service_auth_mode(
            test_user.preferences, "dingtalk", "ai_table"
        )
        == MCP_AUTH_MODE_URL
    )


class _StubResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _StubClient:
    """Minimal synchronous httpx client capturing the refresh request."""

    last: dict = {}

    def __init__(self, *args, **kwargs) -> None:
        pass

    def __enter__(self) -> "_StubClient":
        return self

    def __exit__(self, *args) -> bool:
        return False

    def post(self, url: str, data: dict | None = None, **kwargs) -> _StubResponse:
        _StubClient.last = {"url": url, "data": data or {}}
        return _StubResponse(
            {
                "access_token": "refreshed-access",
                "refresh_token": "rotated-refresh",
                "expires_in": 3600,
                "scope": "user",
            }
        )


class _FailingClient:
    """Stub synchronous httpx client that fails the refresh request."""

    def __init__(self, response=None, error: Exception | None = None) -> None:
        self._response = response
        self._error = error

    def __enter__(self) -> "_FailingClient":
        return self

    def __exit__(self, *args) -> bool:
        return False

    def post(self, url: str, data: dict | None = None, **kwargs):
        if self._error is not None:
            raise self._error
        return self._response


def _configure_refreshable_service(db: Session, user: User) -> None:
    """Seed an OAuth service whose stored access token has already expired."""
    _configure_oauth_service(db, user)
    with_client = user_mcp_service.set_provider_oauth_client(
        user.preferences,
        "dingtalk",
        {"client_id": "dingtalk-client", "token_endpoint": TOKEN_URL},
    )
    with_tokens = user_mcp_service.save_service_oauth_credentials(
        user_mcp_service.dump_preferences(with_client),
        "dingtalk",
        "ai_table",
        access_token="stale-access",
        refresh_token="stale-refresh",
        expires_at=1,
    )
    user.preferences = user_mcp_service.dump_preferences(with_tokens)
    db.add(user)
    db.commit()
    db.refresh(user)


def test_ensure_access_token_sync_refreshes_expiring_token(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An expiring access token is refreshed before the task starts."""
    _configure_refreshable_service(test_db, test_user)

    monkeypatch.setattr(httpx, "Client", _StubClient)

    token = UserMcpOAuthService.ensure_access_token_sync(
        test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
    )

    assert token == "refreshed-access"
    assert _StubClient.last["url"] == TOKEN_URL
    assert _StubClient.last["data"]["grant_type"] == "refresh_token"
    credentials = user_mcp_service.get_service_oauth_credentials(
        test_user.preferences, "dingtalk", "ai_table"
    )
    assert credentials["access_token"] == "refreshed-access"
    assert credentials["refresh_token"] == "rotated-refresh"


def test_rejected_refresh_grant_is_reported_and_cleared(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A revoked grant is logged with its error code and dropped."""
    _configure_refreshable_service(test_db, test_user)
    response = httpx.Response(
        400,
        json={"error": "invalid_grant"},
        request=httpx.Request("POST", TOKEN_URL),
    )
    monkeypatch.setattr(
        httpx, "Client", lambda *args, **kwargs: _FailingClient(response=response)
    )

    with caplog.at_level(logging.WARNING):
        token = UserMcpOAuthService.ensure_access_token_sync(
            test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
        )

    assert token == ""
    assert "invalid_grant" in caplog.text
    credentials = user_mcp_service.get_service_oauth_credentials(
        test_user.preferences, "dingtalk", "ai_table"
    )
    assert credentials["refresh_token"] == ""


def test_transient_refresh_failure_keeps_the_grant(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transport failure keeps the grant so the next attempt can retry."""
    _configure_refreshable_service(test_db, test_user)
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda *args, **kwargs: _FailingClient(error=httpx.ConnectError("offline")),
    )

    token = UserMcpOAuthService.ensure_access_token_sync(
        test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
    )

    assert token == ""
    credentials = user_mcp_service.get_service_oauth_credentials(
        test_user.preferences, "dingtalk", "ai_table"
    )
    assert credentials["refresh_token"] == "stale-refresh"


def test_usable_token_refreshes_thirty_minutes_before_expiry(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A token with less than thirty minutes left is treated as stale."""
    _configure_refreshable_service(test_db, test_user)
    expires_at = int(time.time()) + 1799
    with_tokens = user_mcp_service.save_service_oauth_credentials(
        test_user.preferences,
        "dingtalk",
        "ai_table",
        access_token="expiring-access",
        refresh_token="stale-refresh",
        expires_at=expires_at,
    )
    test_user.preferences = user_mcp_service.dump_preferences(with_tokens)
    test_db.add(test_user)
    test_db.commit()
    test_db.refresh(test_user)

    monkeypatch.setattr(httpx, "Client", _StubClient)

    token = UserMcpOAuthService.ensure_access_token_sync(
        test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
    )

    assert token == "refreshed-access"
    assert _StubClient.last["data"]["grant_type"] == "refresh_token"


@pytest.mark.asyncio
async def test_provider_service_headers_ask_for_reauthorization(
    test_db: Session, test_user: User
) -> None:
    """An OAuth service without a usable token asks the user to reconnect."""
    _configure_oauth_service(test_db, test_user)
    with_client = user_mcp_service.set_provider_oauth_client(
        test_user.preferences,
        "dingtalk",
        {"client_id": "dingtalk-client", "token_endpoint": TOKEN_URL},
    )
    test_user.preferences = user_mcp_service.dump_preferences(with_client)
    test_db.add(test_user)
    test_db.commit()
    test_db.refresh(test_user)

    with pytest.raises(ValueError, match="reconnect"):
        await UserMcpOAuthService.provider_service_headers(
            test_db, user=test_user, provider_id="dingtalk", service_id="ai_table"
        )
