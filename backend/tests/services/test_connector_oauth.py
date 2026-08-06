from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
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

    session = await ConnectorOAuthService.create_session(
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

    assert message.startswith("GitHub is connected")
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
    session = await ConnectorOAuthService.create_session(
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
