"""Refresh results must never overwrite a newer committed grant.

The Python refresh path is the one Wework's local executor actually calls, so
the same compare-and-set invariant the Rust refactor introduced has to hold
here: a refresh that lost the race against another refresh, a re-authorization
or a disconnect drops its own result.
"""

import json
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator

import httpx
import pytest
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_connections import connector_connection_service
from app.services.connector_oauth import ConnectorOAuthService
from shared.utils.crypto import encrypt_sensitive_data

SLUG = "race-connector"


def _create_app(db: Session, user: User) -> None:
    app = connector_app_service.create_app(
        db,
        ConnectorAppWrite.model_validate(
            {
                "slug": SLUG,
                "name": "Race Connector",
                "mcp_url": "https://race.example.test/mcp",
                "auth_type": "oauth2",
            }
        ),
        user,
    )
    spec = dict(app.row.json["spec"])
    spec["oauthClientEncrypted"] = encrypt_sensitive_data(
        json.dumps(
            {
                "issuer": "https://race.example.test",
                "token_endpoint": "https://race.example.test/token",
                "client_id": "race-client",
            }
        )
    )
    app.row.json = {**app.row.json, "spec": spec}
    db.commit()


def _connect(db: Session, user: User, *, access: str, refresh: str):
    return connector_connection_service.save_oauth_connection(
        db,
        slug=SLUG,
        user_id=user.id,
        access_token=access,
        refresh_token=refresh,
        token_type="bearer",
        granted_scopes=["race:read"],
        external_account_name="race@example.test",
        expires_at=datetime.now(timezone.utc).replace(tzinfo=None)
        - timedelta(seconds=1),
    )


def _current(db: Session, user: User):
    db.expire_all()
    return connector_connection_service.get(db, slug=SLUG, user_id=user.id)


@contextmanager
def _competing_writer(db: Session) -> Iterator[Session]:
    """Commit with an independent session inside the test's transaction."""
    with Session(
        bind=db.get_bind(), join_transaction_mode="create_savepoint"
    ) as competing:
        yield competing


def _install_token_endpoint(
    monkeypatch: pytest.MonkeyPatch,
    on_post: Callable[[dict[str, Any]], dict[str, Any]],
) -> None:
    class Response:
        def __init__(self, payload: dict[str, Any]) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return self._payload

    class Client:
        async def __aenter__(self) -> "Client":
            return self

        async def __aexit__(self, *_args) -> None:
            return None

        async def post(self, _url: str, **kwargs: Any) -> Response:
            return Response(on_post(kwargs["data"]))

    monkeypatch.setattr(
        "app.services.connector_oauth.httpx.AsyncClient",
        lambda **_kwargs: Client(),
    )


@pytest.mark.asyncio
async def test_late_rejection_keeps_the_newer_grant(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stale 4xx must not clear the refresh token another request rotated."""
    _create_app(test_db, test_user)
    stale = _connect(test_db, test_user, access="A0", refresh="R0")

    def rotate_then_reject(_data: dict[str, Any]) -> dict[str, Any]:
        with _competing_writer(test_db) as competing:
            _connect(competing, test_user, access="A1", refresh="R1")
        raise ValueError("invalid_grant")

    _install_token_endpoint(monkeypatch, rotate_then_reject)

    result = await ConnectorOAuthService.refresh_connection(test_db, stale)

    current = _current(test_db, test_user)
    assert current is not None
    assert current.access_token() == "A1"
    assert current.refresh_token() == "R1"
    assert current.status == "connected"
    # The caller keeps working with the credentials that won the race.
    assert result is not None
    assert result.access_token() == "A1"


@pytest.mark.asyncio
async def test_late_success_keeps_the_newer_grant(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refresh that finished after a re-authorization cannot replace it."""
    _create_app(test_db, test_user)
    stale = _connect(test_db, test_user, access="A0", refresh="R0")

    def reauthorize_then_succeed(_data: dict[str, Any]) -> dict[str, Any]:
        with _competing_writer(test_db) as competing:
            connector_connection_service.save_oauth_connection(
                competing,
                slug=SLUG,
                user_id=test_user.id,
                access_token="A1",
                refresh_token="R1",
                token_type="bearer",
                granted_scopes=["race:read"],
                external_account_name="other@example.test",
                expires_at=None,
            )
        return {"access_token": "A_late", "refresh_token": "R_late", "expires_in": 3600}

    _install_token_endpoint(monkeypatch, reauthorize_then_succeed)

    result = await ConnectorOAuthService.refresh_connection(test_db, stale)

    current = _current(test_db, test_user)
    assert current is not None
    assert current.access_token() == "A1"
    assert current.refresh_token() == "R1"
    assert current.external_account_name == "other@example.test"
    assert result is not None
    assert result.access_token() == "A1"


@pytest.mark.asyncio
async def test_refresh_result_does_not_revive_a_disconnected_connection(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Disconnecting while the token endpoint is in flight stays disconnected."""
    _create_app(test_db, test_user)
    stale = _connect(test_db, test_user, access="A0", refresh="R0")

    def disconnect_then_succeed(_data: dict[str, Any]) -> dict[str, Any]:
        with _competing_writer(test_db) as competing:
            connector_connection_service.disconnect(
                competing, slug=SLUG, user_id=test_user.id
            )
        return {"access_token": "A_late", "refresh_token": "R_late", "expires_in": 3600}

    _install_token_endpoint(monkeypatch, disconnect_then_succeed)

    result = await ConnectorOAuthService.refresh_connection(test_db, stale)

    assert result is None
    assert _current(test_db, test_user) is None


@pytest.mark.asyncio
async def test_rejected_grant_is_cleared_when_nothing_else_changed(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The failure path still marks a genuinely rejected grant unusable."""
    _create_app(test_db, test_user)
    stale = _connect(test_db, test_user, access="A0", refresh="R0")

    _install_token_endpoint(
        monkeypatch, lambda _data: (_ for _ in ()).throw(ValueError("invalid_grant"))
    )

    assert await ConnectorOAuthService.refresh_connection(test_db, stale) is None

    current = _current(test_db, test_user)
    assert current is not None
    assert current.status == "expired"
    assert current.refresh_token() is None


@pytest.mark.asyncio
async def test_transport_failure_keeps_the_refresh_token(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transient transport error leaves the grant retryable."""
    _create_app(test_db, test_user)
    stale = _connect(test_db, test_user, access="A0", refresh="R0")

    def fail_transport(_data: dict[str, Any]) -> dict[str, Any]:
        raise httpx.ConnectTimeout("timed out")

    _install_token_endpoint(monkeypatch, fail_transport)

    assert await ConnectorOAuthService.refresh_connection(test_db, stale) is None

    current = _current(test_db, test_user)
    assert current is not None
    assert current.status == "expired"
    assert current.refresh_token() == "R0"


@pytest.mark.asyncio
async def test_successful_refresh_keeps_discovered_tools(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rotating tokens must not drop the discovery another request committed."""
    _create_app(test_db, test_user)
    connection = _connect(test_db, test_user, access="A0", refresh="R0")
    connector_connection_service.save_tool_summaries(
        test_db, connection, [{"name": "race_search", "title": None, "description": ""}]
    )

    _install_token_endpoint(
        monkeypatch,
        lambda _data: {
            "access_token": "A1",
            "refresh_token": "R1",
            "expires_in": 3600,
        },
    )

    stale = _current(test_db, test_user)
    assert stale is not None
    refreshed = await ConnectorOAuthService.refresh_connection(test_db, stale)

    assert refreshed is not None
    assert refreshed.access_token() == "A1"
    assert [tool["name"] for tool in refreshed.tool_summaries] == ["race_search"]
