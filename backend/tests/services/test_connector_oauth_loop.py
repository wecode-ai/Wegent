# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""End-to-end connector OAuth loop against a real local provider."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_connections import connector_connection_service
from app.services.connector_oauth import ConnectorOAuthService


class _Provider:
    """A minimal RFC 9728/8414 authorization server plus MCP resource."""

    def __init__(self) -> None:
        self.port = 0
        self.token_requests: list[dict[str, str]] = []
        self.access_tokens: list[str] = []
        self.reject_refresh = False
        self._issued = 0

    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def handle(self, handler: BaseHTTPRequestHandler) -> None:
        path = handler.path.split("?")[0]
        if path == "/mcp":
            # The resource advertises its metadata through WWW-Authenticate.
            handler.send_response(401)
            handler.send_header(
                "www-authenticate",
                f'Bearer resource_metadata="{self.base()}/.well-known/oauth-protected-resource/mcp"',
            )
            handler.send_header("content-length", "0")
            handler.end_headers()
            return
        if path == "/.well-known/oauth-protected-resource/mcp":
            self._json(
                handler,
                {
                    "resource": f"{self.base()}/mcp",
                    "authorization_servers": [self.base()],
                },
            )
            return
        if path == "/.well-known/oauth-authorization-server":
            self._json(
                handler,
                {
                    "issuer": self.base(),
                    "authorization_endpoint": f"{self.base()}/authorize",
                    "token_endpoint": f"{self.base()}/token",
                    "registration_endpoint": f"{self.base()}/register",
                    "scopes_supported": ["mcp.read"],
                },
            )
            return
        if path == "/register":
            self._json(handler, {"client_id": "loop-client"}, status=201)
            return
        if path == "/authorize":
            query = parse_qs(urlsplit(handler.path).query)
            assert query["code_challenge_method"] == ["S256"]
            assert query["code_challenge"][0]
            assert query["resource"] == [f"{self.base()}/mcp"]
            location = (
                f"{query['redirect_uri'][0]}?code=loop-code&state={query['state'][0]}"
            )
            handler.send_response(302)
            handler.send_header("location", location)
            handler.send_header("content-length", "0")
            handler.end_headers()
            return
        if path == "/token":
            self._token(handler)
            return
        handler.send_response(404)
        handler.send_header("content-length", "0")
        handler.end_headers()

    def _token(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("content-length") or 0)
        form = {
            key: values[0]
            for key, values in parse_qs(handler.rfile.read(length).decode()).items()
        }
        self.token_requests.append(form)
        if form.get("grant_type") == "refresh_token" and self.reject_refresh:
            self._json(handler, {"error": "invalid_grant"}, status=400)
            return
        if form.get("grant_type") == "authorization_code":
            verifier = form.get("code_verifier", "")
            digest = hashlib.sha256(verifier.encode()).digest()
            assert (
                self._challenge
                == base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
            )
        self._issued += 1
        access = f"access-{self._issued}"
        self.access_tokens.append(access)
        self._json(
            handler,
            {
                "access_token": access,
                "refresh_token": f"refresh-{self._issued}",
                "token_type": "bearer",
                "expires_in": 3600,
                "scope": "mcp.read",
            },
        )

    def _json(
        self, handler: BaseHTTPRequestHandler, payload: dict, *, status: int = 200
    ) -> None:
        body = json.dumps(payload).encode()
        handler.send_response(status)
        handler.send_header("content-type", "application/json")
        handler.send_header("content-length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)


@pytest.fixture()
def provider() -> _Provider:
    instance = _Provider()
    handler = type("Handler", (BaseHTTPRequestHandler,), {})

    def dispatch(self, *_args) -> None:
        instance.handle(self)

    handler.do_GET = dispatch
    handler.do_POST = dispatch
    handler.log_message = lambda *_args: None
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    instance.port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield instance
    finally:
        server.shutdown()
        server.server_close()


def _session_cache(monkeypatch: pytest.MonkeyPatch) -> dict[str, dict]:
    sessions: dict[str, dict] = {}

    async def cache_set(key: str, value: dict, expire: int) -> bool:
        sessions[key] = dict(value)
        return True

    async def cache_get(key: str):
        return sessions.get(key)

    monkeypatch.setattr(cache_manager, "set", cache_set)
    monkeypatch.setattr(cache_manager, "get", cache_get)
    monkeypatch.setattr(
        settings, "CONNECTOR_OAUTH_REDIRECT_URI", "http://localhost:8000/callback"
    )
    monkeypatch.setattr(ConnectorOAuthService, "_cache_authorized_tools", AsyncMock())
    return sessions


def _create_app(db: Session, user: User, provider: _Provider):
    app = connector_app_service.create_app(
        db,
        ConnectorAppWrite.model_validate(
            {
                "slug": "loop-app",
                "name": "Loop App",
                "mcp_url": f"{provider.base()}/mcp",
                "auth_type": "oauth2",
                "oauth_scope": "mcp.read",
                "tool_allowlist": ["search"],
            }
        ),
        user,
    )
    return app


async def _authorize(db: Session, user: User, provider: _Provider) -> None:
    session = await ConnectorOAuthService.create_session(
        db, slug="loop-app", user_id=user.id
    )
    query = parse_qs(urlsplit(session.authorize_url).query)
    provider._challenge = query["code_challenge"][0]
    async with httpx.AsyncClient(follow_redirects=False) as client:
        redirect = await client.get(session.authorize_url)
    assert redirect.status_code == 302
    callback = parse_qs(urlsplit(redirect.headers["location"]).query)
    await ConnectorOAuthService.complete_callback(
        db, code=callback["code"][0], state_token=callback["state"][0]
    )


@pytest.mark.asyncio
async def test_real_provider_loop_discovers_registers_and_stores_the_grant(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    provider: _Provider,
) -> None:
    """Discovery, DCR, PKCE and the callback run against real HTTP."""
    _session_cache(monkeypatch)
    _create_app(test_db, test_admin_user, provider)

    await _authorize(test_db, test_user, provider)

    connection = connector_connection_service.get(
        test_db, slug="loop-app", user_id=test_user.id
    )
    assert connection is not None
    response = connector_connection_service.response(connection)
    assert response.status == "connected"
    assert response.granted_scopes == ["mcp.read"]
    registration = provider.token_requests[0]
    assert registration["grant_type"] == "authorization_code"
    assert provider.token_requests[-1]["code_verifier"]


@pytest.mark.asyncio
async def test_each_user_keeps_their_own_credentials(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    provider: _Provider,
) -> None:
    """A second authorizer must not overwrite the first user's grant."""
    from app.models.user import User as UserModel

    _session_cache(monkeypatch)
    _create_app(test_db, test_admin_user, provider)
    other = UserModel(
        user_name="loop-other",
        email="loop-other@example.test",
        password_hash="x",
        is_active=True,
        role="user",
    )
    test_db.add(other)
    test_db.commit()
    test_db.refresh(other)

    await _authorize(test_db, test_user, provider)
    await _authorize(test_db, other, provider)

    first = connector_connection_service.get(
        test_db, slug="loop-app", user_id=test_user.id
    )
    second = connector_connection_service.get(
        test_db, slug="loop-app", user_id=other.id
    )
    assert first is not None and second is not None
    assert first.access_token() != second.access_token()


@pytest.mark.asyncio
async def test_expired_grant_refreshes_and_a_rejected_refresh_reauths(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    provider: _Provider,
) -> None:
    """Refresh renews the grant; a rejected refresh clears it."""
    from datetime import datetime, timedelta, timezone

    _session_cache(monkeypatch)
    _create_app(test_db, test_admin_user, provider)
    await _authorize(test_db, test_user, provider)
    connection = connector_connection_service.get(
        test_db, slug="loop-app", user_id=test_user.id
    )
    assert connection is not None
    connector_connection_service.save_oauth_connection(
        test_db,
        slug="loop-app",
        user_id=test_user.id,
        access_token="stale",
        refresh_token="refresh-token",
        token_type="bearer",
        granted_scopes=["mcp.read"],
        external_account_name=None,
        expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )

    refreshed = await ConnectorOAuthService.refresh_connection(test_db, connection)
    assert refreshed is not None
    assert connector_connection_service.response(refreshed).status == "connected"
    assert provider.token_requests[-1]["grant_type"] == "refresh_token"

    provider.reject_refresh = True
    connector_connection_service.save_oauth_connection(
        test_db,
        slug="loop-app",
        user_id=test_user.id,
        access_token="stale",
        refresh_token="refresh-token",
        token_type="bearer",
        granted_scopes=["mcp.read"],
        external_account_name=None,
        expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )
    expired = connector_connection_service.get(
        test_db, slug="loop-app", user_id=test_user.id
    )
    assert expired is not None
    await ConnectorOAuthService.refresh_connection(test_db, expired)
    rejected = connector_connection_service.get(
        test_db, slug="loop-app", user_id=test_user.id
    )
    assert rejected is not None
    assert connector_connection_service.response(rejected).status == "expired"
    assert rejected.refresh_token() is None
