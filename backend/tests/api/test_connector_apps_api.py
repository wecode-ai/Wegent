# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API coverage for administrator-managed connector apps."""

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.connector import (
    ConnectorApp,
    ConnectorConnection,
    ConnectorOAuthSession,
)
from app.models.user import User
from shared.utils.crypto import decrypt_sensitive_data_with_embedded_iv


def _admin_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _app_payload(**overrides):
    payload = {
        "slug": "tickets",
        "name": "Tickets",
        "description": "Search the internal ticket system",
        "enabled": True,
        "visibility": "all",
        "allowed_roles": [],
        "auth_type": "bearer",
        "mcp_url": "https://mcp.example.test/tickets",
        "oauth_scopes": [],
        "provider_headers": {"X-Tenant": "internal-secret"},
        "tool_allowlist": ["search_tickets"],
    }
    payload.update(overrides)
    return payload


def test_admin_can_publish_app_without_secret_disclosure(
    test_client: TestClient,
    test_db: Session,
    test_admin_token: str,
):
    response = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["slug"] == "tickets"
    assert body["provider_headers_configured"] is True
    assert body["provider_header_names"] == ["X-Tenant"]
    assert "provider_headers" not in body

    stored = test_db.query(ConnectorApp).filter_by(slug="tickets").one()
    assert stored.provider_headers_encrypted != '{"X-Tenant":"internal-secret"}'
    assert "internal-secret" in decrypt_sensitive_data_with_embedded_iv(
        stored.provider_headers_encrypted
    )

    preserve_response = test_client.patch(
        f"/api/admin/connector-apps/{stored.id}",
        headers=_admin_headers(test_admin_token),
        json={"name": "Ticket Search"},
    )
    assert preserve_response.status_code == 200
    assert preserve_response.json()["provider_header_names"] == ["X-Tenant"]

    clear_response = test_client.patch(
        f"/api/admin/connector-apps/{stored.id}",
        headers=_admin_headers(test_admin_token),
        json={"clear_provider_headers": True},
    )
    assert clear_response.status_code == 200
    assert clear_response.json()["provider_headers_configured"] is False


def test_oauth_confidential_client_requires_secret(
    test_client: TestClient,
    test_admin_token: str,
):
    oauth_payload = _app_payload(
        slug="oauth-confidential",
        name="OAuth confidential",
        auth_type="oauth2",
        oauth_authorization_url="https://id.example.test/authorize",
        oauth_token_url="https://id.example.test/token",
        oauth_client_id="wegent-client",
        oauth_client_auth_method="client_secret_basic",
        provider_headers={},
    )

    missing_secret = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=oauth_payload,
    )
    public_client = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json={
            **oauth_payload,
            "slug": "oauth-public",
            "oauth_client_auth_method": "none",
        },
    )

    assert missing_secret.status_code == 422
    assert public_client.status_code == 201
    assert public_client.json()["oauth_client_secret_configured"] is False


def test_user_connects_bearer_app_and_receives_scoped_runtime_token(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    test_token: str,
):
    app = ConnectorApp(
        slug="knowledge",
        name="Knowledge",
        description="Internal knowledge",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="bearer",
        mcp_url="https://mcp.example.test/knowledge",
        oauth_scopes=[],
        tool_allowlist=[],
        created_by=test_admin_user.id,
    )
    test_db.add(app)
    test_db.commit()
    test_db.refresh(app)

    connect_response = test_client.put(
        f"/api/connector-apps/{app.id}/credential",
        headers=_admin_headers(test_token),
        json={"token": "user-secret", "account_name": "alice@example.test"},
    )
    token_response = test_client.post(
        "/api/connector-runtime/token", headers=_admin_headers(test_token)
    )

    assert connect_response.status_code == 200
    assert connect_response.json()["connection"]["status"] == "connected"
    assert token_response.status_code == 200
    assert token_response.json()["expires_in"] == 900
    claims = jwt.decode(
        token_response.json()["access_token"],
        settings.SECRET_KEY,
        algorithms=[settings.ALGORITHM],
        audience="wegent-connector-runtime",
    )
    assert claims["sub"] == test_user.user_name
    assert claims["user_id"] == test_user.id
    assert claims["token_type"] == "connector"
    assert claims["scope"] == "connectors:invoke"
    connection = (
        test_db.query(ConnectorConnection)
        .filter_by(user_id=test_user.id, app_id=app.id)
        .one()
    )
    assert connection.access_token_encrypted != "user-secret"
    assert (
        decrypt_sensitive_data_with_embedded_iv(connection.access_token_encrypted)
        == "user-secret"
    )

    invalid_runtime_response = test_client.get(
        "/api/connector-runtime/tools", headers=_admin_headers(test_token)
    )
    assert invalid_runtime_response.status_code == 401


def test_role_visibility_is_enforced_for_user_catalog(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    test_token: str,
):
    test_db.add_all(
        [
            ConnectorApp(
                slug="public-app",
                name="Public",
                description="",
                enabled=True,
                visibility="all",
                allowed_roles=[],
                auth_type="none",
                mcp_url="https://mcp.example.test/public",
                oauth_scopes=[],
                tool_allowlist=[],
                created_by=test_admin_user.id,
            ),
            ConnectorApp(
                slug="admin-app",
                name="Admin only",
                description="",
                enabled=True,
                visibility="roles",
                allowed_roles=["admin"],
                auth_type="none",
                mcp_url="https://mcp.example.test/admin",
                oauth_scopes=[],
                tool_allowlist=[],
                created_by=test_admin_user.id,
            ),
        ]
    )
    test_db.commit()

    response = test_client.get(
        "/api/connector-apps", headers=_admin_headers(test_token)
    )

    assert response.status_code == 200
    assert [item["slug"] for item in response.json()] == ["public-app"]
    assert response.json()[0]["connection"]["status"] == "connected"
    assert test_user.role != "admin"


def test_changing_security_boundary_revokes_existing_connections(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_admin_token: str,
    test_user: User,
):
    app = ConnectorApp(
        slug="revoke-on-change",
        name="Revoked on change",
        description="",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="bearer",
        mcp_url="https://mcp.example.test/revoke",
        oauth_scopes=[],
        tool_allowlist=[],
        created_by=test_admin_user.id,
    )
    test_db.add(app)
    test_db.flush()
    test_db.add(
        ConnectorConnection(
            user_id=test_user.id,
            app_id=app.id,
            status="connected",
            access_token_encrypted="encrypted",
        )
    )
    test_db.commit()

    response = test_client.patch(
        f"/api/admin/connector-apps/{app.id}",
        headers=_admin_headers(test_admin_token),
        json={"mcp_url": "https://mcp.example.test/replacement"},
    )

    assert response.status_code == 200
    assert test_db.query(ConnectorConnection).filter_by(app_id=app.id).count() == 0


def test_disabling_app_revokes_existing_connections(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_admin_token: str,
    test_user: User,
):
    app = ConnectorApp(
        slug="disabled-app",
        name="Disabled app",
        description="",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="none",
        mcp_url="https://mcp.example.test/disabled",
        oauth_scopes=[],
        tool_allowlist=[],
        created_by=test_admin_user.id,
    )
    test_db.add(app)
    test_db.flush()
    test_db.add(
        ConnectorConnection(
            user_id=test_user.id,
            app_id=app.id,
            status="connected",
        )
    )
    test_db.commit()

    response = test_client.delete(
        f"/api/admin/connector-apps/{app.id}",
        headers=_admin_headers(test_admin_token),
    )

    assert response.status_code == 204
    assert test_db.query(ConnectorConnection).filter_by(app_id=app.id).count() == 0
    test_db.refresh(app)
    assert app.enabled is False


def test_oauth_authorization_uses_server_callback_state_and_pkce(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    app = ConnectorApp(
        slug="oauth-docs",
        name="OAuth Docs",
        description="",
        enabled=True,
        visibility="all",
        allowed_roles=[],
        auth_type="oauth2",
        mcp_url="https://mcp.example.test/docs",
        oauth_authorization_url="https://id.example.test/authorize?tenant=internal",
        oauth_token_url="https://id.example.test/token",
        oauth_client_id="wegent-client",
        oauth_scopes=["docs.read"],
        tool_allowlist=[],
        created_by=test_admin_user.id,
    )
    test_db.add(app)
    test_db.commit()

    response = test_client.post(
        f"/api/connector-apps/{app.id}/authorize",
        headers=_admin_headers(test_token),
    )

    assert response.status_code == 200
    authorization_url = response.json()["authorization_url"]
    query = parse_qs(urlsplit(authorization_url).query)
    assert query["tenant"] == ["internal"]
    assert query["client_id"] == ["wegent-client"]
    assert query["scope"] == ["docs.read"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["redirect_uri"][0].endswith("/api/connector-apps/oauth/callback")
    assert "client_secret" not in query
    session = test_db.query(ConnectorOAuthSession).filter_by(app_id=app.id).one()
    assert session.state_hash != query["state"][0]
    connection = (
        test_db.query(ConnectorConnection)
        .filter_by(user_id=test_user.id, app_id=app.id)
        .one()
    )
    assert connection.status == "pending"

    async def exchange_token(
        _: httpx.AsyncClient,
        url: str,
        *,
        data: dict[str, str],
        auth: object,
    ) -> httpx.Response:
        assert url == "https://id.example.test/token"
        assert data["code"] == "provider-code"
        assert data["code_verifier"]
        assert auth is None
        return httpx.Response(
            200,
            json={
                "access_token": "oauth-access-token",
                "refresh_token": "oauth-refresh-token",
                "token_type": "Bearer",
                "scope": "docs.read",
                "expires_in": "3600",
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", exchange_token)
    callback_response = test_client.get(
        "/api/connector-apps/oauth/callback",
        params={"state": query["state"][0], "code": "provider-code"},
    )

    assert callback_response.status_code == 200
    test_db.refresh(connection)
    assert connection.status == "connected"
    assert (
        decrypt_sensitive_data_with_embedded_iv(connection.access_token_encrypted)
        == "oauth-access-token"
    )
    assert (
        decrypt_sensitive_data_with_embedded_iv(connection.refresh_token_encrypted)
        == "oauth-refresh-token"
    )
    test_db.refresh(session)
    assert session.consumed_at is not None


def test_oauth_callback_rejects_oversized_parameters(test_client: TestClient):
    response = test_client.get(
        "/api/connector-apps/oauth/callback",
        params={"state": "s" * 513, "code": "provider-code"},
    )

    assert response.status_code == 422
