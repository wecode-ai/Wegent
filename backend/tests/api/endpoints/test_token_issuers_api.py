# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for outbound token issuer endpoints."""

import jwt
from fastapi.testclient import TestClient


def test_admin_can_create_signing_key_and_issue_outbound_token(
    test_client: TestClient,
    test_admin_token: str,
    test_token: str,
):
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}

    create_key_response = test_client.post(
        "/api/admin/signing-keys",
        headers=admin_headers,
        json={
            "name": "vip-signing-key",
            "description": "Signing key for VIP platform",
        },
    )
    assert create_key_response.status_code == 201
    signing_key = create_key_response.json()

    create_issuer_response = test_client.post(
        "/api/admin/token-issuers",
        headers=admin_headers,
        json={
            "name": "vip-issuer",
            "signing_key_id": signing_key["id"],
            "issuer": "wegent",
            "audience": "vip_sql_platform",
            "default_ttl_seconds": 600,
            "max_ttl_seconds": 900,
            "description": "Issuer for outbound VIP calls",
            "enabled": True,
        },
    )
    assert create_issuer_response.status_code == 201
    issuer = create_issuer_response.json()

    issue_response = test_client.post(
        f"/api/v1/token-issuers/{issuer['id']}/issue",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"expires_in": 300},
    )
    assert issue_response.status_code == 200
    issued = issue_response.json()

    claims = jwt.decode(
        issued["access_token"],
        signing_key["public_key_pem"],
        algorithms=["RS256"],
        audience="vip_sql_platform",
        issuer="wegent",
    )

    assert issued["token_type"] == "Bearer"
    assert issued["issuer_id"] == issuer["id"]
    assert issued["kid"] == signing_key["kid"]
    assert claims["aud"] == "vip_sql_platform"
    assert claims["issuer_id"] == issuer["id"]
    assert claims["user_name"] == "testuser"


def test_admin_cannot_create_enabled_issuer_with_disabled_signing_key(
    test_client: TestClient,
    test_admin_token: str,
):
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}

    create_key_response = test_client.post(
        "/api/admin/signing-keys",
        headers=admin_headers,
        json={"name": "disabled-signing-key"},
    )
    assert create_key_response.status_code == 201
    signing_key = create_key_response.json()

    disable_key_response = test_client.post(
        f"/api/admin/signing-keys/{signing_key['id']}/toggle-status",
        headers=admin_headers,
    )
    assert disable_key_response.status_code == 200
    assert disable_key_response.json()["is_active"] is False

    create_issuer_response = test_client.post(
        "/api/admin/token-issuers",
        headers=admin_headers,
        json={
            "name": "disabled-issuer",
            "signing_key_id": signing_key["id"],
            "issuer": "wegent",
            "audience": "vip_sql_platform",
            "default_ttl_seconds": 600,
            "max_ttl_seconds": 900,
            "enabled": True,
        },
    )

    assert create_issuer_response.status_code == 400
    assert "disabled signing key" in create_issuer_response.json()["detail"]
    assert (
        create_issuer_response.json()["error_code"]
        == "TOKEN_ISSUER_REQUIRES_ACTIVE_SIGNING_KEY"
    )


def test_admin_cannot_disable_signing_key_referenced_by_active_issuer(
    test_client: TestClient,
    test_admin_token: str,
):
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}

    create_key_response = test_client.post(
        "/api/admin/signing-keys",
        headers=admin_headers,
        json={"name": "shared-signing-key"},
    )
    assert create_key_response.status_code == 201
    signing_key = create_key_response.json()

    create_issuer_response = test_client.post(
        "/api/admin/token-issuers",
        headers=admin_headers,
        json={
            "name": "issuer-using-shared-key",
            "signing_key_id": signing_key["id"],
            "issuer": "wegent",
            "audience": "vip_sql_platform",
            "default_ttl_seconds": 600,
            "max_ttl_seconds": 900,
            "enabled": True,
        },
    )
    assert create_issuer_response.status_code == 201

    disable_key_response = test_client.post(
        f"/api/admin/signing-keys/{signing_key['id']}/toggle-status",
        headers=admin_headers,
    )

    assert disable_key_response.status_code == 400
    assert (
        disable_key_response.json()["error_code"]
        == "SIGNING_KEY_DISABLE_BLOCKED_BY_ACTIVE_ISSUER"
    )


def test_issue_endpoint_openapi_declares_oauth2_and_api_key_security(
    test_client: TestClient,
):
    openapi_schema = test_client.app.openapi()
    operation = openapi_schema["paths"]["/api/v1/token-issuers/{issuer_id}/issue"][
        "post"
    ]

    assert {"OAuth2PasswordBearer": []} in operation["security"]
    assert {"APIKeyHeader": []} in operation["security"]
