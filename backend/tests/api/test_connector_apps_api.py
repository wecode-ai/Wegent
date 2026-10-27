# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API coverage for administrator-managed connector apps."""

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import (
    CONNECTOR_APP_KIND,
    CONNECTOR_APP_NAMESPACE,
    ConnectorAppService,
    connector_app_service,
)
from app.services.connector_connections import (
    CONNECTOR_CONNECTION_KIND,
    connector_connection_service,
)
from app.services.connector_oauth import ConnectorOAuthService
from app.services.connector_runtime import ConnectorRuntimeService
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data


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
        "auth_type": "none",
        "mcp_url": "https://mcp.example.test/tickets",
        "provider_headers": {"X-Tenant": "internal-secret"},
        "tool_allowlist": ["search_tickets"],
    }
    payload.update(overrides)
    return payload


def _create_app(
    db: Session,
    admin: User,
    **overrides,
):
    payload = _app_payload(**overrides)
    return connector_app_service.create_app(
        db,
        ConnectorAppWrite.model_validate(payload),
        admin,
    )


def _connector_kind(db: Session, slug: str) -> Kind:
    return (
        db.query(Kind)
        .filter(
            Kind.kind == CONNECTOR_APP_KIND,
            Kind.namespace == CONNECTOR_APP_NAMESPACE,
            Kind.name == slug,
            Kind.is_active,
        )
        .one()
    )


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

    stored = _connector_kind(test_db, "tickets")
    encrypted_headers = stored.json["spec"]["providerHeadersEncrypted"]
    assert encrypted_headers != '{"X-Tenant":"internal-secret"}'
    assert "internal-secret" in decrypt_sensitive_data(encrypted_headers)

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


def test_authorization_connector_types_are_persisted(
    test_client: TestClient,
    test_db: Session,
    test_admin_token: str,
):
    bearer_response = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(slug="bearer-app", auth_type="bearer"),
    )
    oauth_response = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(slug="oauth-app", auth_type="oauth2"),
    )

    assert bearer_response.status_code == 201
    assert bearer_response.json()["auth_type"] == "bearer"
    bearer_app = ConnectorAppService.get_app_by_slug(test_db, "bearer-app")
    assert bearer_app is not None
    assert bearer_app.auth_type == "bearer"

    assert oauth_response.status_code == 201
    assert oauth_response.json()["auth_type"] == "oauth2"
    oauth_app = ConnectorAppService.get_app_by_slug(test_db, "oauth-app")
    assert oauth_app is not None
    assert oauth_app.auth_type == "oauth2"


def test_tool_loading_mode_is_persisted(
    test_client: TestClient,
    test_db: Session,
    test_admin_token: str,
):
    default_response = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(slug="default-loading"),
    )
    lazy_response = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(
            slug="lazy-loading",
            tool_loading_mode="lazy",
            keywords=["表格", "spreadsheet"],
        ),
    )

    assert default_response.status_code == 201
    assert default_response.json()["tool_loading_mode"] == "static"
    assert lazy_response.status_code == 201
    assert lazy_response.json()["tool_loading_mode"] == "lazy"
    assert lazy_response.json()["keywords"] == ["表格", "spreadsheet"]

    stored = _connector_kind(test_db, "lazy-loading")
    assert stored.json["spec"]["toolLoadingMode"] == "lazy"
    assert stored.json["spec"]["keywords"] == ["表格", "spreadsheet"]

    update_response = test_client.patch(
        f"/api/admin/connector-apps/{stored.id}",
        headers=_admin_headers(test_admin_token),
        json={"tool_loading_mode": "static"},
    )
    assert update_response.status_code == 200
    assert update_response.json()["tool_loading_mode"] == "static"


def test_legacy_loading_mode_names_are_normalized(
    test_client: TestClient,
    test_admin_token: str,
):
    legacy_static = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(slug="legacy-static", tool_loading_mode="direct"),
    )
    legacy_lazy = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(slug="legacy-lazy", tool_loading_mode="skill"),
    )

    assert legacy_static.status_code == 201
    assert legacy_static.json()["tool_loading_mode"] == "static"
    assert legacy_lazy.status_code == 201
    assert legacy_lazy.json()["tool_loading_mode"] == "lazy"


def test_admin_can_clear_registered_oauth_client(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_admin_token: str,
):
    app = _create_app(
        test_db,
        test_admin_user,
        slug="oauth-app",
        name="OAuth App",
        auth_type="oauth2",
    )
    spec = dict(app.row.json["spec"])
    spec["oauthClientEncrypted"] = encrypt_sensitive_data(
        json.dumps({"issuer": "https://oauth.example.test", "client_id": "client"})
    )
    app.row.json = {**app.row.json, "spec": spec}
    test_db.commit()

    response = test_client.patch(
        f"/api/admin/connector-apps/{app.id}",
        headers=_admin_headers(test_admin_token),
        json={"clear_oauth_client": True},
    )

    assert response.status_code == 200
    assert response.json()["oauth_client_registered"] is False
    stored = _connector_kind(test_db, "oauth-app")
    assert "oauthClientEncrypted" not in stored.json["spec"]


def test_admin_can_update_tool_allowlist_with_empty_oauth_scope(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_admin_token: str,
):
    app = _create_app(
        test_db,
        test_admin_user,
        slug="oauth-app",
        name="OAuth App",
        auth_type="oauth2",
        oauth_scope=None,
    )
    allowlist = [
        "list_bases",
        "search_bases",
        "get_base",
        "list_tables",
        "search_records",
    ]

    response = test_client.patch(
        f"/api/admin/connector-apps/{app.id}",
        headers=_admin_headers(test_admin_token),
        json={"oauth_scope": None, "tool_allowlist": allowlist},
    )

    assert response.status_code == 200
    assert response.json()["tool_allowlist"] == allowlist
    assert response.json()["oauth_scope"] is None


def test_discover_oauth_connector_requires_authorization(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_admin_token: str,
):
    app = _create_app(
        test_db,
        test_admin_user,
        slug="oauth-app",
        name="OAuth App",
        auth_type="oauth2",
    )

    response = test_client.post(
        f"/api/admin/connector-apps/{app.id}/tools/discover",
        headers=_admin_headers(test_admin_token),
    )

    assert response.status_code == 401
    assert "requires authorization" in response.json()["detail"]


def test_github_oauth_api_flow_connects_polls_and_disconnects(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_token: str,
    monkeypatch,
):
    _create_app(
        test_db,
        test_admin_user,
        slug="github",
        name="GitHub",
        auth_type="oauth2",
        tool_allowlist=[],
    )
    sessions: dict[str, dict] = {}

    async def cache_set(key: str, value: dict, expire: int) -> bool:
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
                "scope": "repo",
            }
        ),
    )
    monkeypatch.setattr(
        ConnectorOAuthService,
        "_fetch_github_login",
        AsyncMock(return_value="octocat"),
    )

    session_response = test_client.post(
        "/api/connector-apps/github/oauth/sessions",
        headers=_admin_headers(test_token),
    )
    assert session_response.status_code == 200
    session = session_response.json()
    state = parse_qs(urlsplit(session["authorize_url"]).query)["state"][0]
    callback_response = test_client.get(
        "/api/connector-apps/oauth/callback",
        params={"state": state, "code": "provider-code"},
    )
    assert callback_response.status_code == 200

    poll_response = test_client.get(
        f"/api/connector-apps/oauth/sessions/{session['session_id']}/poll",
        params={"poll_token": session["poll_token"]},
        headers=_admin_headers(test_token),
    )
    assert poll_response.status_code == 200
    assert poll_response.json()["connection"]["external_account_name"] == "octocat"

    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_ID", "")
    disconnect_response = test_client.delete(
        "/api/connector-apps/github/connection",
        headers=_admin_headers(test_token),
    )
    assert disconnect_response.status_code == 204


def test_role_visibility_is_enforced_for_user_catalog(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    test_token: str,
):
    _create_app(
        test_db,
        test_admin_user,
        slug="public-app",
        name="Public",
        tool_loading_mode="lazy",
        keywords=["tickets", "工单"],
    )
    _create_app(
        test_db,
        test_admin_user,
        slug="admin-app",
        name="Admin only",
        visibility="roles",
        allowed_roles=["admin"],
        tool_allowlist=[],
    )

    response = test_client.get(
        "/api/connector-apps", headers=_admin_headers(test_token)
    )

    assert response.status_code == 200
    assert [item["slug"] for item in response.json()] == ["public-app"]
    assert response.json()[0]["connection"]["status"] == "connected"
    # The settings search relies on real keywords from the user projection.
    assert response.json()[0]["keywords"] == ["tickets", "工单"]
    assert test_user.role != "admin"


def test_deleting_app_hard_deletes_kind_and_user_connections(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    test_admin_token: str,
):
    app = _create_app(
        test_db,
        test_admin_user,
        slug="disabled-app",
        name="Disabled app",
        tool_allowlist=[],
    )
    connector_connection_service.save_oauth_connection(
        test_db,
        slug=app.slug,
        user_id=test_user.id,
        access_token="user-token",
        refresh_token=None,
        token_type="bearer",
        granted_scopes=[],
        external_account_name="octocat",
        expires_at=None,
    )

    response = test_client.delete(
        f"/api/admin/connector-apps/{app.id}",
        headers=_admin_headers(test_admin_token),
    )

    assert response.status_code == 204
    test_db.expire_all()
    assert test_db.query(Kind).filter(Kind.id == app.id).first() is None
    assert (
        test_db.query(Kind)
        .filter(
            Kind.kind == CONNECTOR_CONNECTION_KIND,
            Kind.name == app.slug,
        )
        .first()
        is None
    )
    recreate_response = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(slug="disabled-app", name="Recreated app"),
    )
    assert recreate_response.status_code == 201
    assert recreate_response.json()["slug"] == "disabled-app"


def test_legacy_authorization_endpoints_stay_removed(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_token: str,
):
    app = _create_app(
        test_db,
        test_admin_user,
        slug="catalog-only",
        name="Catalog only",
        tool_allowlist=[],
    )

    authorize_response = test_client.post(
        f"/api/connector-apps/{app.id}/authorize",
        headers=_admin_headers(test_token),
    )
    credential_response = test_client.put(
        f"/api/connector-apps/{app.id}/credential",
        headers=_admin_headers(test_token),
        json={"token": "user-secret"},
    )
    callback_response = test_client.get(
        "/api/connector-apps/oauth/callback",
        params={"state": "state", "code": "provider-code"},
    )

    assert authorize_response.status_code == 404
    assert credential_response.status_code == 404
    assert callback_response.status_code == 400


def test_admin_can_publish_http_api_as_connector_tools(
    test_client: TestClient,
    test_admin_token: str,
):
    response = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(
            slug="ticket-http",
            name="Ticket HTTP API",
            transport="http",
            mcp_url="https://tickets.example.test/api",
            provider_headers={},
            http_tools=[
                {
                    "name": "get_ticket",
                    "description": "Get one ticket",
                    "method": "GET",
                    "path": "/tickets/{id}",
                    "input_schema": {
                        "type": "object",
                        "properties": {"id": {"type": "string"}},
                        "required": ["id"],
                    },
                    "argument_locations": {"id": "path"},
                    "timeout_seconds": 20,
                }
            ],
            tool_allowlist=["get_ticket"],
        ),
    )

    assert response.status_code == 201
    assert response.json()["transport"] == "http"
    assert response.json()["http_tools"][0]["name"] == "get_ticket"


def test_http_connector_requires_valid_tool_definitions(
    test_client: TestClient,
    test_admin_token: str,
):
    missing_tools = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(
            slug="http-empty",
            transport="http",
            provider_headers={},
        ),
    )
    unsafe_path = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(
            slug="http-unsafe",
            transport="http",
            provider_headers={},
            http_tools=[
                {
                    "name": "escape",
                    "method": "GET",
                    "path": "https://attacker.example.test/steal",
                    "input_schema": {"type": "object", "properties": {}},
                }
            ],
        ),
    )
    unknown_allowlist = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(
            slug="http-unknown-tool",
            transport="http",
            provider_headers={},
            http_tools=[
                {
                    "name": "lookup",
                    "method": "GET",
                    "path": "/lookup",
                    "input_schema": {"type": "object", "properties": {}},
                }
            ],
            tool_allowlist=["missing"],
        ),
    )

    assert missing_tools.status_code == 422
    assert unsafe_path.status_code == 422
    assert unknown_allowlist.status_code == 422


def test_apps_projection_lists_and_reads_callable_connector(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_token: str,
):
    _create_app(
        test_db,
        test_admin_user,
        slug="projection-api",
        name="Projection API",
        description="Projection coverage",
        transport="http",
        mcp_url="https://projection.example.test/api",
        provider_headers={},
        tool_allowlist=["lookup"],
        http_tools=[
            {
                "name": "lookup",
                "description": "Lookup projection data",
                "method": "GET",
                "path": "/lookup",
                "input_schema": {"type": "object", "properties": {}},
            }
        ],
    )

    list_response = test_client.get(
        "/api/apps/list", headers=_admin_headers(test_token)
    )
    read_response = test_client.post(
        "/api/apps/read",
        headers=_admin_headers(test_token),
        json={"app_ids": ["projection-api", "missing"], "include_tools": True},
    )

    assert list_response.status_code == 200
    listed = [
        item for item in list_response.json()["data"] if item["id"] == "projection-api"
    ][0]
    assert listed["is_accessible"] is True
    assert listed["callable"] is True

    assert read_response.status_code == 200
    assert read_response.json()["missing_app_ids"] == ["missing"]
    assert (
        read_response.json()["apps"][0]["tool_summaries"][0]["raw_tool_name"]
        == "lookup"
    )


def test_expired_oauth_connector_remains_visible_but_not_callable(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_user: User,
    test_token: str,
    monkeypatch,
):
    app = _create_app(
        test_db,
        test_admin_user,
        slug="expired-oauth",
        name="Expired OAuth",
        auth_type="oauth2",
        tool_allowlist=[],
    )
    app.row.json["spec"]["oauthClientEncrypted"] = encrypt_sensitive_data(
        json.dumps(
            {
                "issuer": "https://oauth.example.test",
                "resource": "https://mcp.example.test",
                "token_endpoint": "https://oauth.example.test/token",
                "client_id": "client-id",
            }
        )
    )
    test_db.commit()
    connection = connector_connection_service.save_oauth_connection(
        test_db,
        slug=app.slug,
        user_id=test_user.id,
        access_token="expired-token",
        refresh_token="refresh-token",
        token_type="bearer",
        granted_scopes=["user"],
        external_account_name="dingtalk-user",
        expires_at=datetime.now(timezone.utc).replace(tzinfo=None)
        - timedelta(seconds=1),
    )
    assert connection is not None

    installed_response = test_client.get(
        "/api/apps/list", headers=_admin_headers(test_token)
    )
    assert installed_response.status_code == 200
    installed = [
        item for item in installed_response.json()["data"] if item["id"] == app.slug
    ][0]
    assert installed["connection"]["status"] == "expired"
    assert installed["callable"] is False

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "access_token": "refreshed-token",
                "refresh_token": "next-refresh-token",
                "expires_in": 7200,
                "token_type": "bearer",
            }

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(
        "app.services.connector_oauth.httpx.AsyncClient",
        lambda **_kwargs: Client(),
    )
    refresh_response = test_client.post(
        f"/api/connector-apps/{app.slug}/connection/refresh",
        headers=_admin_headers(test_token),
    )

    assert refresh_response.status_code == 200
    assert refresh_response.json()["status"] == "connected"


def test_apps_projection_rejects_malformed_cursor(
    test_client: TestClient,
    test_token: str,
):
    response = test_client.get(
        "/api/apps/list?cursor=not-a-number", headers=_admin_headers(test_token)
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "cursor must be a numeric offset"


def test_admin_can_register_wegent_sites_mcp_connector(
    test_client: TestClient,
    test_db: Session,
    test_admin_token: str,
):
    response = test_client.post(
        "/api/admin/connector-apps",
        headers=_admin_headers(test_admin_token),
        json=_app_payload(
            slug="wegent-sites",
            name="Wegent Sites",
            description="Create, version, deploy, inspect, and roll back Wegent Sites projects.",
            transport="streamable-http",
            mcp_url="https://sites.example.test/mcp",
            provider_headers={"Authorization": "Bearer mcp-token"},
            tool_allowlist=[],
        ),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["slug"] == "wegent-sites"
    assert body["provider_headers_configured"] is True
    assert body["provider_header_names"] == ["Authorization"]

    app = ConnectorAppService.get_app_by_slug(test_db, "wegent-sites")
    assert app is not None
    assert app.name == "Wegent Sites"
    assert app.transport == "streamable-http"
    assert app.auth_type == "none"
    assert app.mcp_url == "https://sites.example.test/mcp"


def test_admin_can_test_a_connector_app_restricted_to_other_roles(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_admin_token: str,
    monkeypatch,
):
    """Catalog validation must not depend on the admin's own visibility."""
    assert test_admin_user.role != "member"
    app = _create_app(
        test_db,
        test_admin_user,
        slug="members-only",
        name="Members only",
        transport="http",
        mcp_url="https://tickets.example.test/api",
        visibility="roles",
        allowed_roles=["member"],
        http_tools=[
            {
                "name": "get_ticket",
                "description": "Get one ticket",
                "method": "GET",
                "path": "/tickets/{id}",
                "input_schema": {
                    "type": "object",
                    "properties": {"id": {"type": "string"}},
                    "required": ["id"],
                },
                "argument_locations": {"id": "path"},
                "timeout_seconds": 20,
            }
        ],
        tool_allowlist=["get_ticket"],
    )

    async def fake_call_http_tool(config, definition, arguments):
        return ([{"type": "text", "text": "ok"}], None, False)

    monkeypatch.setattr(
        ConnectorRuntimeService,
        "_call_http_tool",
        staticmethod(fake_call_http_tool),
    )

    response = test_client.post(
        f"/api/admin/connector-apps/{app.id}/tools/test",
        headers=_admin_headers(test_admin_token),
        json={"name": "get_ticket", "arguments": {"id": "1"}},
    )

    assert response.status_code == 200
    assert response.json()["is_error"] is False
