from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_connections import connector_connection_service
from app.services.connector_oauth import ConnectorOAuthService
from shared.utils.crypto import decrypt_sensitive_data


@pytest.mark.asyncio
async def test_github_oauth_session_persists_encrypted_user_connection(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sessions: dict[str, dict] = {}

    async def cache_set(key: str, value: dict, expire: int) -> bool:
        assert expire > 0
        sessions[key] = dict(value)
        return True

    async def cache_get(key: str):
        value = sessions.get(key)
        return dict(value) if value else None

    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_ID", "github-client")
    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_SECRET", "github-secret")
    monkeypatch.setattr(settings, "CONNECTOR_OAUTH_STATE_SECRET", "state-secret")
    monkeypatch.setattr(cache_manager, "set", cache_set)
    monkeypatch.setattr(cache_manager, "get", cache_get)
    monkeypatch.setattr(
        ConnectorOAuthService,
        "_exchange_code",
        AsyncMock(
            return_value={
                "access_token": "github-access-token",
                "token_type": "bearer",
                "scope": "repo,read:org",
            }
        ),
    )
    monkeypatch.setattr(
        ConnectorOAuthService,
        "_fetch_github_login",
        AsyncMock(return_value="octocat"),
    )
    monkeypatch.setattr(
        ConnectorOAuthService,
        "_cache_authorized_tools",
        AsyncMock(),
    )
    connector_app_service.create_app(
        test_db,
        ConnectorAppWrite.model_validate(
            {
                "slug": "github",
                "name": "GitHub",
                "mcp_url": "https://api.github.com",
                "auth_type": "oauth2",
            }
        ),
        test_user,
    )

    session = await ConnectorOAuthService.create_session(
        test_db,
        slug="github",
        user_id=test_user.id,
    )
    state = parse_qs(urlsplit(session.authorize_url).query)["state"][0]
    message = await ConnectorOAuthService.complete_callback(
        test_db,
        code="provider-code",
        state_token=state,
    )
    result = await ConnectorOAuthService.poll_session(
        test_db,
        session_id=session.session_id,
        poll_token=session.poll_token,
        user_id=test_user.id,
    )

    assert message.startswith("Connector is connected")
    assert result.status == "success"
    assert result.connection
    assert result.connection.external_account_name == "octocat"
    connection = connector_connection_service.get(
        test_db,
        slug="github",
        user_id=test_user.id,
    )
    assert connection is not None
    assert connection.access_token_encrypted != "github-access-token"
    assert (
        decrypt_sensitive_data(connection.access_token_encrypted)
        == "github-access-token"
    )
    assert connection.granted_scopes == ["read:org", "repo"]


@pytest.mark.asyncio
async def test_oauth_poll_is_scoped_to_the_authorizing_user(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sessions: dict[str, dict] = {}

    async def cache_set(key: str, value: dict, expire: int) -> bool:
        sessions[key] = dict(value)
        return True

    async def cache_get(key: str):
        return sessions.get(key)

    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_ID", "github-client")
    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_SECRET", "github-secret")
    monkeypatch.setattr(cache_manager, "set", cache_set)
    monkeypatch.setattr(cache_manager, "get", cache_get)
    connector_app_service.create_app(
        test_db,
        ConnectorAppWrite.model_validate(
            {
                "slug": "github",
                "name": "GitHub",
                "mcp_url": "https://api.github.com",
                "auth_type": "oauth2",
            }
        ),
        test_user,
    )
    session = await ConnectorOAuthService.create_session(
        test_db,
        slug="github",
        user_id=test_user.id,
    )

    with pytest.raises(HTTPException) as exc_info:
        await ConnectorOAuthService.poll_session(
            test_db,
            session_id=session.session_id,
            poll_token=session.poll_token,
            user_id=test_user.id + 1,
        )

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_expiring_github_token_can_be_refreshed(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = connector_connection_service.save_oauth_connection(
        test_db,
        slug="github",
        user_id=test_user.id,
        access_token="expired-token",
        refresh_token="refresh-token",
        token_type="bearer",
        granted_scopes=["repo"],
        external_account_name="octocat",
        expires_at=datetime.now(timezone.utc).replace(tzinfo=None)
        - timedelta(seconds=1),
    )

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "access_token": "refreshed-token",
                "refresh_token": "next-refresh-token",
                "expires_in": 3600,
                "token_type": "bearer",
            }

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_ID", "github-client")
    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_SECRET", "github-secret")
    monkeypatch.setattr(
        "app.services.connector_oauth.httpx.AsyncClient",
        lambda **_kwargs: Client(),
    )

    refreshed = await ConnectorOAuthService.refresh_connection(test_db, connection)

    assert refreshed is not None
    assert refreshed.access_token() == "refreshed-token"
    assert refreshed.refresh_token() == "next-refresh-token"


@pytest.mark.asyncio
async def test_rejected_refresh_drops_the_refresh_token(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rejected grant must stop looking refreshable and ask for authorization."""
    connection = connector_connection_service.save_oauth_connection(
        test_db,
        slug="github",
        user_id=test_user.id,
        access_token="expired-token",
        refresh_token="revoked-refresh-token",
        token_type="bearer",
        granted_scopes=["repo"],
        external_account_name="octocat",
        expires_at=datetime.now(timezone.utc).replace(tzinfo=None)
        - timedelta(seconds=1),
    )
    request = httpx.Request("POST", "https://github.com/login/oauth/access_token")

    class Response:
        def raise_for_status(self) -> None:
            raise httpx.HTTPStatusError(
                "400 Bad Request",
                request=request,
                response=httpx.Response(400, request=request),
            )

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_ID", "github-client")
    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_SECRET", "github-secret")
    monkeypatch.setattr(
        "app.services.connector_oauth.httpx.AsyncClient",
        lambda **_kwargs: Client(),
    )

    refreshed = await ConnectorOAuthService.refresh_connection(test_db, connection)
    stored = connector_connection_service.get(
        test_db, slug="github", user_id=test_user.id
    )

    assert refreshed is None
    assert stored is not None
    assert stored.refresh_token() is None
    assert connector_connection_service.is_usable(stored) is False


@pytest.mark.asyncio
async def test_dynamic_connector_oauth_uses_discovery_dcr_and_resource(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A standards-compliant MCP OAuth server can be connected without pre-registration."""
    app = connector_app_service.create_app(
        test_db,
        ConnectorAppWrite.model_validate(
            {
                "slug": "weibo-design",
                "name": "Weibo Design",
                "mcp_url": "https://fig.example.test/mcp",
                "auth_type": "oauth2",
                "oauth_scope": "figma:mcp",
            }
        ),
        test_user,
    )
    sessions: dict[str, dict] = {}

    async def cache_set(key: str, value: dict, expire: int) -> bool:
        sessions[key] = dict(value)
        return True

    async def cache_get(key: str):
        return sessions.get(key)

    monkeypatch.setattr(settings, "CONNECTOR_OAUTH_STATE_SECRET", "state-secret")
    monkeypatch.setattr(
        settings,
        "CONNECTOR_OAUTH_REDIRECT_URI",
        "https://wegent.test/api/connector-apps/oauth/callback",
    )
    monkeypatch.setattr(cache_manager, "set", cache_set)
    monkeypatch.setattr(cache_manager, "get", cache_get)
    monkeypatch.setattr(
        "app.services.connector_oauth.discover_connector_oauth",
        AsyncMock(
            return_value={
                "resource": "https://fig.example.test/mcp",
                "issuer": "https://fig.example.test",
                "authorization_endpoint": "https://fig.example.test/authorize",
                "token_endpoint": "https://fig.example.test/token",
                "registration_endpoint": "https://fig.example.test/register",
                "scope": "figma:mcp figma:rest",
            }
        ),
    )

    class RegistrationResponse:
        status_code = 201

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"client_id": "fig-client"}

    class RegistrationClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return RegistrationResponse()

    monkeypatch.setattr(
        "app.services.connector_oauth.httpx.AsyncClient",
        lambda **_kwargs: RegistrationClient(),
    )

    session = await ConnectorOAuthService.create_session(
        test_db,
        slug="weibo-design",
        user_id=test_user.id,
    )
    query = parse_qs(urlsplit(session.authorize_url).query)
    assert query["resource"] == ["https://fig.example.test/mcp"]
    assert query["scope"] == ["figma:mcp"]
    assert query["code_challenge_method"] == ["S256"]

    async def exchange_dynamic_code(*, session: dict, code: str) -> dict:
        assert session["client_id"] == "fig-client"
        return {
            "access_token": "fig-access-token",
            "refresh_token": "fig-refresh-token",
            "token_type": "bearer",
            "expires_in": 3600,
            "scope": "figma:mcp",
        }

    monkeypatch.setattr(
        ConnectorOAuthService,
        "_exchange_dynamic_code",
        exchange_dynamic_code,
    )
    monkeypatch.setattr(
        ConnectorOAuthService,
        "_cache_authorized_tools",
        AsyncMock(),
    )
    message = await ConnectorOAuthService.complete_callback(
        test_db,
        code="provider-code",
        state_token=query["state"][0],
    )
    assert message.startswith("Connector is connected")

    refreshed = connector_app_service.get_app_by_slug(test_db, "weibo-design")
    assert refreshed is not None
    assert refreshed.oauth_client_encrypted
    assert refreshed.oauth_client_encrypted
