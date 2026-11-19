import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_connections import connector_connection_service
from app.services.connector_oauth import ConnectorOAuthService
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data


@pytest.mark.asyncio
async def test_dynamic_connection_refreshes_with_pkce_client_and_resource(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dynamic connector refreshes use the DCR client and RFC 8707 resource."""
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
    app.row.json["spec"]["oauthClientEncrypted"] = app.row.json["spec"].get(
        "oauthClientEncrypted"
    )
    client_data = {
        "issuer": "https://fig.example.test",
        "resource": "https://fig.example.test/mcp",
        "token_endpoint": "https://fig.example.test/token",
        "client_id": "fig-client",
    }
    from shared.utils.crypto import encrypt_sensitive_data

    spec = dict(app.row.json["spec"])
    spec["oauthClientEncrypted"] = encrypt_sensitive_data(
        __import__("json").dumps(client_data)
    )
    app.row.json = {**app.row.json, "spec": spec}
    test_db.commit()

    connection = connector_connection_service.save_oauth_connection(
        test_db,
        slug="weibo-design",
        user_id=test_user.id,
        access_token="expired",
        refresh_token="refresh",
        token_type="bearer",
        granted_scopes=["figma:mcp"],
        external_account_name=None,
        expires_at=datetime.now(timezone.utc).replace(tzinfo=None)
        - timedelta(seconds=1),
    )

    captured = {}

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "access_token": "refreshed",
                "refresh_token": "next-refresh",
                "expires_in": 3600,
                "token_type": "bearer",
                "scope": "figma:mcp",
            }

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url: str, **kwargs):
            captured["url"] = url
            captured["data"] = kwargs["data"]
            return Response()

    import app.services.connector_oauth as service

    monkeypatch.setattr(
        service.httpx,
        "AsyncClient",
        lambda **_kwargs: Client(),
    )

    refreshed = await ConnectorOAuthService.refresh_connection(test_db, connection)

    assert refreshed is not None
    assert refreshed.access_token() == "refreshed"
    assert captured["url"] == "https://fig.example.test/token"
    assert captured["data"]["client_id"] == "fig-client"
    assert captured["data"]["resource"] == "https://fig.example.test/mcp"


@pytest.mark.asyncio
async def test_dynamic_client_reregisters_when_redirect_uri_changes(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deploying a new public callback URL must not reuse a localhost DCR client."""
    app = connector_app_service.create_app(
        test_db,
        ConnectorAppWrite.model_validate(
            {
                "slug": "weibo-design",
                "name": "Weibo Design",
                "mcp_url": "https://fig.example.test/mcp",
                "auth_type": "oauth2",
            }
        ),
        test_user,
    )
    spec = dict(app.row.json["spec"])
    spec["oauthClientEncrypted"] = encrypt_sensitive_data(
        json.dumps(
            {
                "issuer": "https://fig.example.test",
                "resource": "https://fig.example.test/mcp",
                "token_endpoint": "https://fig.example.test/token",
                "registration_endpoint": "https://fig.example.test/register",
                "redirect_uri": "http://localhost:8000/api/connector-apps/oauth/callback",
                "client_id": "old-client",
            }
        )
    )
    app.row.json = {**app.row.json, "spec": spec}
    test_db.commit()

    redirect_uri = "https://wegent.example.test/api/connector-apps/oauth/callback"
    monkeypatch.setattr(
        "app.services.connector_oauth.settings.CONNECTOR_OAUTH_REDIRECT_URI",
        redirect_uri,
    )
    captured = {}

    class RegistrationResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"client_id": "new-client"}

    class RegistrationClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url: str, **kwargs):
            captured.update(kwargs)
            return RegistrationResponse()

    monkeypatch.setattr(
        "app.services.connector_oauth.httpx.AsyncClient",
        lambda **_kwargs: RegistrationClient(),
    )

    client = await ConnectorOAuthService._dynamic_client(
        test_db,
        app=app,
        metadata={
            "issuer": "https://fig.example.test",
            "resource": "https://fig.example.test/mcp",
            "authorization_endpoint": "https://fig.example.test/authorize",
            "token_endpoint": "https://fig.example.test/token",
            "registration_endpoint": "https://fig.example.test/register",
        },
    )

    assert client["client_id"] == "new-client"
    assert captured["json"]["redirect_uris"] == [redirect_uri]


@pytest.mark.asyncio
async def test_dynamic_client_waits_for_another_instance_registration(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A competing instance reads the shared registration instead of re-registering."""
    app = connector_app_service.create_app(
        test_db,
        ConnectorAppWrite.model_validate(
            {
                "slug": "weibo-design",
                "name": "Weibo Design",
                "mcp_url": "https://fig.example.test/mcp",
                "auth_type": "oauth2",
            }
        ),
        test_user,
    )
    client_data = {
        "issuer": "https://fig.example.test",
        "resource": "https://fig.example.test/mcp",
        "token_endpoint": "https://fig.example.test/token",
        "redirect_uri": "http://localhost:8000/api/connector-apps/oauth/callback",
        "client_id": "shared-client",
    }

    @asynccontextmanager
    async def not_acquired(*_args, **_kwargs):
        spec = dict(app.row.json["spec"])
        spec["oauthClientEncrypted"] = encrypt_sensitive_data(json.dumps(client_data))
        app.row.json = {**app.row.json, "spec": spec}
        test_db.commit()
        yield False

    monkeypatch.setattr(
        "app.services.connector_oauth.distributed_lock.acquire_watchdog_context_async",
        not_acquired,
    )

    client = await ConnectorOAuthService._dynamic_client(
        test_db,
        app=app,
        metadata={
            "issuer": "https://fig.example.test",
            "resource": "https://fig.example.test/mcp",
            "authorization_endpoint": "https://fig.example.test/authorize",
            "token_endpoint": "https://fig.example.test/token",
            "registration_endpoint": "https://fig.example.test/register",
        },
    )

    assert client["client_id"] == "shared-client"
