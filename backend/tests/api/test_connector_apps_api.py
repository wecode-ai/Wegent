# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API coverage for administrator-managed connector apps."""

from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy.orm import Session

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
from shared.utils.crypto import decrypt_sensitive_data


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


def test_authorization_connector_types_are_rejected(
    test_client: TestClient,
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

    assert bearer_response.status_code == 422
    assert oauth_response.status_code == 422


def test_runtime_token_is_scoped_to_connector_invocation(
    test_client: TestClient,
    test_user: User,
    test_token: str,
):
    token_response = test_client.post(
        "/api/connector-runtime/token", headers=_admin_headers(test_token)
    )

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
    _create_app(test_db, test_admin_user, slug="public-app", name="Public")
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
    assert test_user.role != "admin"


def test_disabling_app_soft_deletes_connector_kind(
    test_client: TestClient,
    test_db: Session,
    test_admin_user: User,
    test_admin_token: str,
):
    app = _create_app(
        test_db,
        test_admin_user,
        slug="disabled-app",
        name="Disabled app",
        tool_allowlist=[],
    )

    response = test_client.delete(
        f"/api/admin/connector-apps/{app.id}",
        headers=_admin_headers(test_admin_token),
    )

    assert response.status_code == 204
    row = test_db.query(Kind).filter(Kind.id == app.id).one()
    assert row.is_active is False
    assert row.json["spec"]["enabled"] is False


def test_removed_authorization_endpoints_return_not_found(
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
    assert callback_response.status_code == 404


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


def test_apps_projection_lists_reads_and_installs_callable_connector(
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
    installed_response = test_client.get(
        "/api/apps/installed", headers=_admin_headers(test_token)
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

    assert installed_response.status_code == 200
    installed = [
        item
        for item in installed_response.json()["apps"]
        if item["id"] == "projection-api"
    ][0]
    assert installed["callable"] is True
    assert installed["tool_summaries"][0]["name"] == "projection-api__lookup"


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
