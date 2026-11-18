"""Keep dynamic OAuth registration bound to the current app definition."""

from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.schemas.connector import ConnectorAppUpdate, ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_oauth import ConnectorOAuthService

RESOURCE = "https://connector.example.test/mcp"
METADATA = {
    "issuer": "https://connector.example.test",
    "resource": RESOURCE,
    "authorization_endpoint": "https://connector.example.test/authorize",
    "token_endpoint": "https://connector.example.test/token",
    "registration_endpoint": "https://connector.example.test/register",
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("change", "unavailable"),
    [
        ({"name": "Renamed", "tool_allowlist": ["allowed"]}, False),
        ({"enabled": False}, True),
        ({"mcp_url": "https://replacement.example.test/mcp"}, True),
        ({"auth_type": "none"}, True),
    ],
)
async def test_registration_does_not_overwrite_concurrent_app_edits(
    mcp_test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    change: dict,
    unavailable: bool,
) -> None:
    app = connector_app_service.create_app(
        mcp_test_db,
        ConnectorAppWrite(
            slug="registration-race",
            name="Original",
            mcp_url=RESOURCE,
            auth_type="oauth2",
        ),
        SimpleNamespace(id=1),
    )

    async def send(_client, request, **_kwargs):
        with Session(mcp_test_db.get_bind()) as editor:
            current = connector_app_service.get_app(editor, app.id)
            connector_app_service.update_app(
                editor, current, ConnectorAppUpdate(**change)
            )
        return httpx.Response(201, json={"client_id": "registered"}, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
    if unavailable:
        with pytest.raises(HTTPException) as caught:
            await ConnectorOAuthService._register_dynamic_client(
                mcp_test_db, app, METADATA
            )
        assert caught.value.status_code == 409
        mcp_test_db.rollback()
    else:
        client = await ConnectorOAuthService._register_dynamic_client(
            mcp_test_db, app, METADATA
        )
        assert client["client_id"] == "registered"

    mcp_test_db.expire_all()
    current = connector_app_service.get_app(mcp_test_db, app.id)
    for field, value in change.items():
        assert getattr(current, field) == value
    assert bool(current.oauth_client_encrypted) is not unavailable


@pytest.mark.asyncio
async def test_deleted_app_cannot_receive_a_late_registration(
    mcp_test_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = connector_app_service.create_app(
        mcp_test_db,
        ConnectorAppWrite(
            slug="deleted-registration",
            name="Original",
            mcp_url=RESOURCE,
            auth_type="oauth2",
        ),
        SimpleNamespace(id=1),
    )

    async def send(_client, request, **_kwargs):
        with Session(mcp_test_db.get_bind()) as editor:
            current = connector_app_service.get_app(editor, app.id)
            connector_app_service.delete_app(editor, current)
        return httpx.Response(201, json={"client_id": "registered"}, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
    with pytest.raises(HTTPException) as caught:
        await ConnectorOAuthService._register_dynamic_client(mcp_test_db, app, METADATA)
    assert caught.value.status_code == 404
    mcp_test_db.rollback()
    assert connector_app_service.get_app_by_slug(mcp_test_db, app.slug) is None


@pytest.mark.asyncio
async def test_deleted_app_during_discovery_returns_not_found(
    mcp_test_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = connector_app_service.create_app(
        mcp_test_db,
        ConnectorAppWrite(
            slug="deleted-discovery",
            name="Original",
            mcp_url=RESOURCE,
            auth_type="oauth2",
        ),
        SimpleNamespace(id=1),
    )

    async def discover(_resource: str) -> dict:
        with Session(mcp_test_db.get_bind()) as editor:
            current = connector_app_service.get_app(editor, app.id)
            connector_app_service.delete_app(editor, current)
        return METADATA

    monkeypatch.setattr(
        "app.services.connector_oauth.discover_connector_oauth", discover
    )
    with pytest.raises(HTTPException) as caught:
        await ConnectorOAuthService.create_session(
            mcp_test_db, slug=app.slug, user_id=1
        )
    assert caught.value.status_code == 404
