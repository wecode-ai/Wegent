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
from app.services.connector_oauth import (
    ConnectorOAuthService,
    GitHubToken,
)
from shared.utils.crypto import decrypt_sensitive_data


def _oauth(test_db: Session) -> ConnectorOAuthService:
    return ConnectorOAuthService(
        lambda: Session(
            bind=test_db.get_bind(),
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
    )


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
    service = _oauth(test_db)
    monkeypatch.setattr(
        service,
        "_exchange_code",
        AsyncMock(
            return_value=GitHubToken(
                access_token="github-access-token",
                refresh_token=None,
                token_type="bearer",
                scopes=("repo", "read:org"),
                expires_in=None,
            )
        ),
    )
    monkeypatch.setattr(
        service,
        "_fetch_github_login",
        AsyncMock(return_value="octocat"),
    )

    session = await service.create_session(
        slug="github",
        user_id=test_user.id,
    )
    state = parse_qs(urlsplit(session.authorize_url).query)["state"][0]
    message = await service.complete_callback(
        code="provider-code",
        state_token=state,
    )
    result = await service.poll_session(
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
    assert connection.granted_scopes == ("read:org", "repo")


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
    service = _oauth(test_db)
    session = await service.create_session(
        slug="github",
        user_id=test_user.id,
    )

    with pytest.raises(HTTPException) as exc_info:
        await service.poll_session(
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

    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_ID", "github-client")
    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_SECRET", "github-secret")
    service = _oauth(test_db)
    monkeypatch.setattr(
        service,
        "_refresh_github_token",
        AsyncMock(
            return_value=GitHubToken(
                access_token="refreshed-token",
                refresh_token="next-refresh-token",
                token_type="bearer",
                scopes=(),
                expires_in=3600,
            )
        ),
    )

    refreshed = await service.refresh_connection(
        slug=connection.slug,
        user_id=connection.user_id,
    )

    assert refreshed is not None
    assert refreshed.access_token() == "refreshed-token"
    assert refreshed.refresh_token() == "next-refresh-token"
