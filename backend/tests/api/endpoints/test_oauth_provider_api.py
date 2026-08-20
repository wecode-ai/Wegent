# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""End-to-end API tests for the constrained external OAuth provider."""

import base64
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.oauth_refresh_token import OAuthRefreshToken
from app.models.user import User
from app.services.auth import oauth_provider as oauth_provider_module
from app.services.auth.outbound_token_service import outbound_token_service


class FakeOAuthCache:
    def __init__(self) -> None:
        self.values: dict[str, object] = {}

    async def get(self, key: str):
        return self.values.get(key)

    async def set(self, key: str, value, expire: int | None = None) -> bool:
        self.values[key] = value
        return True

    async def pop(self, key: str):
        return self.values.pop(key, None)


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _basic_auth(client_id: str, client_secret: str) -> str:
    encoded = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    return f"Basic {encoded}"


def _create_oauth_client(
    test_client: TestClient,
    test_admin_token: str,
    *,
    client_type: str = "confidential",
    access_ttl_seconds: int = 600,
    issuer_max_ttl_seconds: int = 3600,
) -> dict:
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}
    signing_key = test_client.post(
        "/api/admin/signing-keys",
        headers=admin_headers,
        json={"name": f"oauth-key-{client_type}"},
    ).json()
    issuer_response = test_client.post(
        "/api/admin/token-issuers",
        headers=admin_headers,
        json={
            "name": f"oauth-issuer-{client_type}",
            "signing_key_id": signing_key["id"],
            "issuer": "wegent-oauth",
            "audience": "wegent-userinfo",
            "default_ttl_seconds": 600,
            "max_ttl_seconds": issuer_max_ttl_seconds,
            "enabled": True,
        },
    )
    assert issuer_response.status_code == 201
    client_response = test_client.post(
        "/api/admin/oauth-clients",
        headers=admin_headers,
        json={
            "name": f"external-app-{client_type}",
            "client_type": client_type,
            "redirect_uris": ["https://client.example/callback"],
            "token_issuer_id": issuer_response.json()["id"],
            "access_ttl_seconds": access_ttl_seconds,
            "refresh_ttl_seconds": 86400,
            "enabled": True,
        },
    )
    assert client_response.status_code == 201
    return client_response.json()


def test_authorization_code_refresh_and_auth_boundaries(
    test_client: TestClient,
    test_admin_token: str,
    test_token: str,
    monkeypatch,
    caplog,
):
    cache = FakeOAuthCache()
    monkeypatch.setattr(oauth_provider_module, "cache_manager", cache)
    client = _create_oauth_client(test_client, test_admin_token)
    assert client["client_secret"]

    listed = test_client.get(
        "/api/admin/oauth-clients",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )
    assert listed.status_code == 200
    assert listed.json()["items"][0]["client_secret"] is None

    verifier = "oauth-pkce-verifier-" + ("a" * 48)
    authorize_response = test_client.get(
        "/api/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": client["client_id"],
            "redirect_uri": "https://client.example/callback",
            "scope": "userinfo.read",
            "state": "state-123",
            "code_challenge": _pkce_challenge(verifier),
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    assert authorize_response.status_code == 302
    request_id = parse_qs(urlparse(authorize_response.headers["location"]).query)[
        "request_id"
    ][0]

    details = test_client.get(
        f"/api/oauth/authorization-requests/{request_id}",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert details.status_code == 200
    assert details.json()["client_name"] == "external-app-confidential"
    assert details.json()["scope"] == "userinfo.read"

    approval = test_client.post(
        f"/api/oauth/authorization-requests/{request_id}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert approval.status_code == 200
    approval_query = parse_qs(urlparse(approval.json()["redirect_url"]).query)
    assert approval_query["state"] == ["state-123"]
    code = approval_query["code"][0]

    invalid_client_response = test_client.post(
        "/api/oauth/token",
        headers={"Authorization": _basic_auth(client["client_id"], "wrong-secret")},
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "https://client.example/callback",
            "code_verifier": verifier,
        },
    )
    assert invalid_client_response.status_code == 401
    assert invalid_client_response.headers["www-authenticate"].startswith("Basic ")

    token_response = test_client.post(
        "/api/oauth/token",
        headers={
            "Authorization": _basic_auth(client["client_id"], client["client_secret"])
        },
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "https://client.example/callback",
            "code_verifier": verifier,
        },
    )
    assert token_response.status_code == 200
    assert token_response.headers["cache-control"] == "no-store"
    tokens = token_response.json()

    userinfo = test_client.get(
        "/api/oauth/userinfo",
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    assert userinfo.status_code == 200
    assert set(userinfo.json()) == {"id", "user_name", "email"}
    assert userinfo.json()["user_name"] == "testuser"

    wegent_api = test_client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    assert wegent_api.status_code == 401

    session_token_on_userinfo = test_client.get(
        "/api/oauth/userinfo",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert session_token_on_userinfo.status_code == 401

    refresh_response = test_client.post(
        "/api/oauth/token",
        headers={
            "Authorization": _basic_auth(client["client_id"], client["client_secret"])
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
    )
    assert refresh_response.status_code == 200
    refreshed = refresh_response.json()
    assert refreshed["refresh_token"] != tokens["refresh_token"]

    replay_response = test_client.post(
        "/api/oauth/token",
        headers={
            "Authorization": _basic_auth(client["client_id"], client["client_secret"])
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
    )
    assert replay_response.status_code == 400
    assert replay_response.json()["error"] == "invalid_grant"
    assert "OAuth refresh token replay detected" in caplog.text

    revoked_family_response = test_client.post(
        "/api/oauth/token",
        headers={
            "Authorization": _basic_auth(client["client_id"], client["client_secret"])
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": refreshed["refresh_token"],
        },
    )
    assert revoked_family_response.status_code == 400


def test_public_client_and_invalid_redirect(
    test_client: TestClient,
    test_admin_token: str,
    monkeypatch,
):
    cache = FakeOAuthCache()
    monkeypatch.setattr(oauth_provider_module, "cache_manager", cache)
    client = _create_oauth_client(test_client, test_admin_token, client_type="public")
    assert client["client_secret"] is None

    response = test_client.get(
        "/api/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": client["client_id"],
            "redirect_uri": "https://attacker.example/callback",
            "scope": "userinfo.read",
            "code_challenge": _pkce_challenge("b" * 64),
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"
    assert cache.values == {}

    valid_redirect_error = test_client.get(
        "/api/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": client["client_id"],
            "redirect_uri": "https://client.example/callback",
            "scope": "unsupported.scope",
            "state": "preserved-state",
            "code_challenge": _pkce_challenge("b" * 64),
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    error_query = parse_qs(urlparse(valid_redirect_error.headers["location"]).query)
    assert valid_redirect_error.status_code == 302
    assert error_query["error"] == ["invalid_scope"]
    assert error_query["state"] == ["preserved-state"]


def test_oauth_provider_metadata(test_client: TestClient):
    response = test_client.get("/api/.well-known/oauth-authorization-server")
    assert response.status_code == 200
    payload = response.json()
    assert payload["authorization_endpoint"].endswith("/api/oauth/authorize")
    assert payload["grant_types_supported"] == [
        "authorization_code",
        "refresh_token",
    ]


def test_rejects_malformed_pkce_verifier_without_server_error(
    test_client: TestClient,
    test_admin_token: str,
    test_token: str,
    monkeypatch,
):
    cache = FakeOAuthCache()
    monkeypatch.setattr(oauth_provider_module, "cache_manager", cache)
    client = _create_oauth_client(test_client, test_admin_token, client_type="public")
    verifier = "c" * 64
    authorize_response = test_client.get(
        "/api/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": client["client_id"],
            "redirect_uri": "https://client.example/callback",
            "scope": "userinfo.read",
            "code_challenge": _pkce_challenge(verifier),
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    request_id = parse_qs(urlparse(authorize_response.headers["location"]).query)[
        "request_id"
    ][0]
    approval = test_client.post(
        f"/api/oauth/authorization-requests/{request_id}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    code = parse_qs(urlparse(approval.json()["redirect_url"]).query)["code"][0]

    response = test_client.post(
        "/api/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": client["client_id"],
            "code": code,
            "redirect_uri": "https://client.example/callback",
            "code_verifier": "非 ASCII verifier",
        },
    )

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_grant"


def test_userinfo_rejects_malformed_signed_claims(
    test_client: TestClient,
    test_admin_token: str,
    test_db: Session,
):
    client = _create_oauth_client(test_client, test_admin_token)
    issued = outbound_token_service.sign_claims(
        test_db,
        issuer_id=client["token_issuer_id"],
        subject="user:invalid",
        expires_in=60,
        claims={
            "token_use": "external_userinfo",
            "scope": "userinfo.read",
            "client_id": client["client_id"],
            "client_kind_id": "not-an-integer",
            "user_id": "not-an-integer",
        },
    )

    response = test_client.get(
        "/api/oauth/userinfo",
        headers={"Authorization": f"Bearer {issued.access_token}"},
    )

    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"
    assert response.headers["www-authenticate"] == 'Bearer error="invalid_token"'


def test_oauth_client_policy_blocks_unsafe_issuer_changes(
    test_client: TestClient,
    test_admin_token: str,
):
    client = _create_oauth_client(test_client, test_admin_token)
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}

    delete_response = test_client.delete(
        f"/api/admin/token-issuers/{client['token_issuer_id']}",
        headers=admin_headers,
    )
    audience_response = test_client.put(
        f"/api/admin/token-issuers/{client['token_issuer_id']}",
        headers=admin_headers,
        json={"audience": "other-audience"},
    )
    ttl_response = test_client.put(
        f"/api/admin/token-issuers/{client['token_issuer_id']}",
        headers=admin_headers,
        json={"max_ttl_seconds": 300},
    )

    assert delete_response.status_code == 400
    assert audience_response.status_code == 400
    assert ttl_response.status_code == 400


def test_oauth_client_ttl_must_fit_issuer_policy(
    test_client: TestClient,
    test_admin_token: str,
):
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}
    signing_key = test_client.post(
        "/api/admin/signing-keys",
        headers=admin_headers,
        json={"name": "oauth-key-short-ttl"},
    ).json()
    issuer = test_client.post(
        "/api/admin/token-issuers",
        headers=admin_headers,
        json={
            "name": "oauth-issuer-short-ttl",
            "signing_key_id": signing_key["id"],
            "issuer": "wegent-oauth",
            "audience": "wegent-userinfo",
            "default_ttl_seconds": 300,
            "max_ttl_seconds": 300,
            "enabled": True,
        },
    ).json()

    response = test_client.post(
        "/api/admin/oauth-clients",
        headers=admin_headers,
        json={
            "name": "external-app-too-long",
            "client_type": "public",
            "redirect_uris": ["https://client.example/callback"],
            "token_issuer_id": issuer["id"],
            "access_ttl_seconds": 600,
            "refresh_ttl_seconds": 86400,
            "enabled": True,
        },
    )

    assert response.status_code == 400


def test_security_sensitive_client_update_revokes_refresh_tokens(
    test_client: TestClient,
    test_admin_token: str,
    test_db: Session,
    test_user: User,
):
    client = _create_oauth_client(test_client, test_admin_token)
    refresh_token = OAuthRefreshToken(
        token_hash=hashlib.sha256(b"existing-refresh-token").hexdigest(),
        token_prefix="wgrt_existing",
        family_id=str(uuid.uuid4()),
        client_kind_id=client["id"],
        user_id=test_user.id,
        expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=1),
    )
    test_db.add(refresh_token)
    test_db.commit()
    test_db.refresh(refresh_token)

    response = test_client.put(
        f"/api/admin/oauth-clients/{client['id']}",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={"client_type": "public"},
    )

    assert response.status_code == 200
    assert response.json()["client_type"] == "public"
    test_db.refresh(refresh_token)
    assert refresh_token.revoked_at is not None
