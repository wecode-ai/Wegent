# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""End-to-end API tests for the constrained external OAuth provider."""

import base64
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.oauth_refresh_token import (
    OAUTH_REFRESH_TOKEN_UNSET_TIME,
    OAuthRefreshToken,
)
from app.models.user import User
from app.services.auth import oauth_provider as oauth_provider_module
from app.services.auth.outbound_token_service import outbound_token_service


class FakeOAuthCache:
    def __init__(self) -> None:
        self.values: dict[str, object] = {}

    async def get(self, key: str) -> object | None:
        return self.values.get(key)

    async def set(self, key: str, value: object, expire: int | None = None) -> bool:
        self.values[key] = value
        return True

    async def pop(self, key: str) -> object | None:
        return self.values.pop(key, None)


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _basic_auth(client_id: str, client_secret: str) -> str:
    encoded = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    return f"Basic {encoded}"


def _create_oauth_client(
    test_client: TestClient,
    access_token: str,
    *,
    client_type: str = "confidential",
    name: str | None = None,
) -> dict:
    client_response = test_client.post(
        "/api/oauth-clients",
        headers={"Authorization": f"Bearer {access_token}"},
        json={
            "name": name or f"external-app-{client_type}",
            "client_type": client_type,
            "redirect_uris": ["https://client.example/callback"],
        },
    )
    assert client_response.status_code == 201
    return client_response.json()


def _oauth_issuer_id(test_client: TestClient, access_token: str) -> int:
    response = test_client.get(
        "/api/admin/token-issuers",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    return int(items[0]["id"])


def _authorize_client(
    test_client: TestClient,
    test_token: str,
    client: dict,
    verifier: str,
) -> str:
    authorize_response = test_client.get(
        "/api/external/oauth/authorize",
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
        f"/api/external/oauth/authorization-requests/{request_id}",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert details.status_code == 200
    assert details.json()["client_name"] == client["name"]
    assert details.json()["scope"] == "userinfo.read"

    approval = test_client.post(
        f"/api/external/oauth/authorization-requests/{request_id}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert approval.status_code == 200
    approval_query = parse_qs(urlparse(approval.json()["redirect_url"]).query)
    assert approval_query["state"] == ["state-123"]
    assert approval_query["iss"] == [oauth_provider_module.oauth_provider_issuer()]
    return approval_query["code"][0]


def _exchange_authorization_code(
    test_client: TestClient,
    client: dict,
    *,
    code: str,
    verifier: str,
) -> dict:
    token_response = test_client.post(
        "/api/external/oauth/token",
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
    return token_response.json()


def _assert_external_access_token_boundaries(
    test_client: TestClient,
    *,
    client: dict,
    tokens: dict,
    session_token: str,
) -> None:
    access_token_header = jwt.get_unverified_header(tokens["access_token"])
    access_token_claims = jwt.decode(
        tokens["access_token"], options={"verify_signature": False}
    )
    assert access_token_header["typ"] == "at+jwt"
    assert access_token_claims["iss"] == oauth_provider_module.oauth_provider_issuer()
    assert access_token_claims["aud"] == "wegent-userinfo"
    assert access_token_claims["client_id"] == client["client_id"]
    assert access_token_claims["scope"] == "userinfo.read"
    assert access_token_claims["jti"]

    jwks_response = test_client.get("/api/external/oauth/jwks")
    assert jwks_response.status_code == 200
    assert access_token_header["kid"] in {
        key["kid"] for key in jwks_response.json()["keys"]
    }

    userinfo = test_client.get(
        "/api/external/oauth/userinfo",
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
        "/api/external/oauth/userinfo",
        headers={"Authorization": f"Bearer {session_token}"},
    )
    assert session_token_on_userinfo.status_code == 401


def test_confidential_client_secret_is_shown_only_at_creation(
    test_client: TestClient,
    test_admin_token: str,
) -> None:
    client = _create_oauth_client(test_client, test_admin_token)
    assert client["client_secret"]

    listed = test_client.get(
        "/api/admin/oauth-clients",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert listed.status_code == 200
    assert listed.json()["items"][0]["client_secret"] is None


def test_authorization_code_access_token_and_auth_boundaries(
    test_client: TestClient,
    test_admin_token: str,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(oauth_provider_module, "cache_manager", FakeOAuthCache())
    client = _create_oauth_client(test_client, test_admin_token)
    verifier = "oauth-pkce-verifier-" + ("a" * 48)
    code = _authorize_client(test_client, test_token, client, verifier)

    invalid_client_response = test_client.post(
        "/api/external/oauth/token",
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

    tokens = _exchange_authorization_code(
        test_client,
        client,
        code=code,
        verifier=verifier,
    )
    _assert_external_access_token_boundaries(
        test_client,
        client=client,
        tokens=tokens,
        session_token=test_token,
    )


def test_refresh_token_rotation_rejects_replay_and_revokes_family(
    test_client: TestClient,
    test_admin_token: str,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(oauth_provider_module, "cache_manager", FakeOAuthCache())
    client = _create_oauth_client(test_client, test_admin_token)
    verifier = "oauth-pkce-verifier-" + ("b" * 48)
    code = _authorize_client(test_client, test_token, client, verifier)
    tokens = _exchange_authorization_code(
        test_client,
        client,
        code=code,
        verifier=verifier,
    )

    refresh_response = test_client.post(
        "/api/external/oauth/token",
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
        "/api/external/oauth/token",
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
        "/api/external/oauth/token",
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
        "/api/external/oauth/authorize",
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
        "/api/external/oauth/authorize",
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
    assert error_query["iss"] == [oauth_provider_module.oauth_provider_issuer()]


def test_oauth_provider_metadata(test_client: TestClient) -> None:
    response = test_client.get("/.well-known/oauth-authorization-server/api")
    assert response.status_code == 200
    payload = response.json()
    assert payload["issuer"] == oauth_provider_module.oauth_provider_issuer()
    assert payload["authorization_endpoint"].endswith("/api/external/oauth/authorize")
    assert payload["jwks_uri"].endswith("/api/external/oauth/jwks")
    assert payload["authorization_response_iss_parameter_supported"] is True
    assert payload["grant_types_supported"] == [
        "authorization_code",
        "refresh_token",
    ]


def test_oauth_client_creation_bootstraps_signing_resources(
    test_client: TestClient,
    test_admin_token: str,
):
    response = test_client.post(
        "/api/oauth-clients",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={
            "name": "auto-provisioned-oauth-client",
            "client_type": "confidential",
            "redirect_uris": ["https://client.example/callback"],
        },
    )

    assert response.status_code == 201
    second_response = test_client.post(
        "/api/oauth-clients",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={
            "name": "second-auto-provisioned-oauth-client",
            "client_type": "public",
            "redirect_uris": ["https://second-client.example/callback"],
        },
    )
    assert second_response.status_code == 201

    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}
    issuers_response = test_client.get(
        "/api/admin/token-issuers",
        headers=admin_headers,
    )
    signing_keys_response = test_client.get(
        "/api/admin/signing-keys",
        headers=admin_headers,
    )
    assert issuers_response.status_code == 200
    assert issuers_response.json()["total"] == 1
    assert issuers_response.json()["items"][0]["default_ttl_seconds"] == 3600
    assert issuers_response.json()["items"][0]["max_ttl_seconds"] == 3600
    assert signing_keys_response.status_code == 200
    assert signing_keys_response.json()["total"] == 1

    jwks_response = test_client.get("/api/external/oauth/jwks")
    assert jwks_response.status_code == 200
    assert len(jwks_response.json()["keys"]) == 1


def test_oauth_client_reuses_existing_provider_issuer_and_preserves_ttl(
    test_client: TestClient,
    test_admin_token: str,
) -> None:
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}
    signing_key = test_client.post(
        "/api/admin/signing-keys",
        headers=admin_headers,
        json={"name": "existing-oauth-provider-key"},
    ).json()
    issuer = test_client.post(
        "/api/admin/token-issuers",
        headers=admin_headers,
        json={
            "name": "existing-oauth-provider-issuer",
            "signing_key_id": signing_key["id"],
            "issuer": oauth_provider_module.oauth_provider_issuer(),
            "audience": "wegent-userinfo",
            "default_ttl_seconds": 1800,
            "max_ttl_seconds": 7200,
            "enabled": True,
        },
    ).json()

    response = test_client.post(
        "/api/oauth-clients",
        headers=admin_headers,
        json={
            "name": "client-using-existing-provider",
            "client_type": "public",
            "redirect_uris": ["https://client.example/callback"],
        },
    )

    assert response.status_code == 201
    issuers_response = test_client.get(
        "/api/admin/token-issuers",
        headers=admin_headers,
    )
    assert issuers_response.json()["total"] == 1
    assert issuers_response.json()["items"][0]["id"] == issuer["id"]
    assert issuers_response.json()["items"][0]["default_ttl_seconds"] == 1800
    assert issuers_response.json()["items"][0]["max_ttl_seconds"] == 7200


def test_oauth_client_raises_only_insufficient_provider_issuer_max_ttl(
    test_client: TestClient,
    test_admin_token: str,
) -> None:
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}
    signing_key = test_client.post(
        "/api/admin/signing-keys",
        headers=admin_headers,
        json={"name": "short-oauth-provider-key"},
    ).json()
    issuer = test_client.post(
        "/api/admin/token-issuers",
        headers=admin_headers,
        json={
            "name": "short-oauth-provider-issuer",
            "signing_key_id": signing_key["id"],
            "issuer": oauth_provider_module.oauth_provider_issuer(),
            "audience": "wegent-userinfo",
            "default_ttl_seconds": 600,
            "max_ttl_seconds": 600,
            "enabled": True,
        },
    ).json()

    response = test_client.post(
        "/api/oauth-clients",
        headers=admin_headers,
        json={
            "name": "client-raising-provider-limit",
            "client_type": "public",
            "redirect_uris": ["https://client.example/callback"],
        },
    )

    assert response.status_code == 201
    issuers_response = test_client.get(
        "/api/admin/token-issuers",
        headers=admin_headers,
    )
    assert issuers_response.json()["total"] == 1
    assert issuers_response.json()["items"][0]["id"] == issuer["id"]
    assert issuers_response.json()["items"][0]["default_ttl_seconds"] == 600
    assert issuers_response.json()["items"][0]["max_ttl_seconds"] == 3600


def test_token_endpoint_rejects_multiple_client_authentication_methods(
    test_client: TestClient,
):
    response = test_client.post(
        "/api/external/oauth/token",
        headers={"Authorization": _basic_auth("client", "secret")},
        data={
            "grant_type": "refresh_token",
            "client_id": "client",
            "refresh_token": "refresh-token",
        },
    )

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_revocation_endpoint_follows_rfc7009(
    test_client: TestClient,
    test_admin_token: str,
):
    client = _create_oauth_client(test_client, test_admin_token)
    headers = {
        "Authorization": _basic_auth(client["client_id"], client["client_secret"])
    }

    unknown_token = test_client.post(
        "/api/external/oauth/revoke",
        headers=headers,
        data={
            "token": "unknown-token",
            "token_type_hint": "refresh_token",
        },
    )
    unsupported_token_type = test_client.post(
        "/api/external/oauth/revoke",
        headers=headers,
        data={
            "token": "unknown-token",
            "token_type_hint": "access_token",
        },
    )

    assert unknown_token.status_code == 200
    assert unsupported_token_type.status_code == 400
    assert unsupported_token_type.json()["error"] == "unsupported_token_type"


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
        "/api/external/oauth/authorize",
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
        f"/api/external/oauth/authorization-requests/{request_id}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    code = parse_qs(urlparse(approval.json()["redirect_url"]).query)["code"][0]

    response = test_client.post(
        "/api/external/oauth/token",
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
    issuer_id = _oauth_issuer_id(test_client, test_admin_token)
    issued = outbound_token_service.sign_claims(
        test_db,
        issuer_id=issuer_id,
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
        "/api/external/oauth/userinfo",
        headers={"Authorization": f"Bearer {issued.access_token}"},
    )

    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"
    assert response.headers["www-authenticate"].startswith(
        'Bearer realm="userinfo", error="invalid_token"'
    )


def test_oauth_client_policy_blocks_unsafe_issuer_changes(
    test_client: TestClient,
    test_admin_token: str,
):
    _create_oauth_client(test_client, test_admin_token)
    issuer_id = _oauth_issuer_id(test_client, test_admin_token)
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}

    delete_response = test_client.delete(
        f"/api/admin/token-issuers/{issuer_id}",
        headers=admin_headers,
    )
    audience_response = test_client.put(
        f"/api/admin/token-issuers/{issuer_id}",
        headers=admin_headers,
        json={"audience": "other-audience"},
    )
    ttl_response = test_client.put(
        f"/api/admin/token-issuers/{issuer_id}",
        headers=admin_headers,
        json={"max_ttl_seconds": 300},
    )

    assert delete_response.status_code == 400
    assert audience_response.status_code == 400
    assert ttl_response.status_code == 400


def test_oauth_client_rejects_provider_managed_fields(
    test_client: TestClient,
    test_admin_token: str,
):
    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}
    response = test_client.post(
        "/api/oauth-clients",
        headers=admin_headers,
        json={
            "name": "external-app-too-long",
            "client_type": "public",
            "redirect_uris": ["https://client.example/callback"],
            "token_issuer_id": 123,
            "access_ttl_seconds": 600,
            "refresh_ttl_seconds": 86400,
            "enabled": False,
        },
    )

    assert response.status_code == 422


def test_oauth_client_rejects_redirect_uri_fragments_on_create_and_update(
    test_client: TestClient,
    test_admin_token: str,
) -> None:
    headers = {"Authorization": f"Bearer {test_admin_token}"}
    create_with_fragment = test_client.post(
        "/api/oauth-clients",
        headers=headers,
        json={
            "name": "fragment-client",
            "redirect_uris": ["https://client.example/callback#done"],
        },
    )
    client = _create_oauth_client(
        test_client,
        test_admin_token,
        client_type="public",
        name="valid-redirect-client",
    )
    update_with_fragment = test_client.put(
        f"/api/oauth-clients/{client['id']}",
        headers=headers,
        json={"redirect_uris": ["https://client.example/callback#done"]},
    )

    assert create_with_fragment.status_code == 422
    assert update_with_fragment.status_code == 422


def test_oauth_client_defaults_to_public(
    test_client: TestClient,
    test_admin_token: str,
) -> None:
    response = test_client.post(
        "/api/oauth-clients",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={
            "name": "default-public-client",
            "redirect_uris": ["http://127.0.0.1:8765/callback"],
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["client_type"] == "public"
    assert payload["client_secret"] is None


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
        f"/api/oauth-clients/{client['id']}",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={"client_type": "public"},
    )

    assert response.status_code == 200
    assert response.json()["client_type"] == "public"
    test_db.refresh(refresh_token)
    assert refresh_token.revoked_at != OAUTH_REFRESH_TOKEN_UNSET_TIME


def test_oauth_client_self_service_is_owner_scoped(
    test_client: TestClient,
    test_token: str,
    test_admin_token: str,
):
    user_client = _create_oauth_client(
        test_client,
        test_token,
        client_type="public",
        name="shared-display-name",
    )
    admin_client = _create_oauth_client(
        test_client,
        test_admin_token,
        client_type="public",
        name="shared-display-name",
    )

    user_list = test_client.get(
        "/api/oauth-clients",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert user_list.status_code == 200
    assert [item["id"] for item in user_list.json()["items"]] == [user_client["id"]]
    assert user_list.json()["items"][0]["owner_user_name"] == "testuser"

    cross_owner_update = test_client.put(
        f"/api/oauth-clients/{admin_client['id']}",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"enabled": False},
    )
    assert cross_owner_update.status_code == 404

    admin_list = test_client.get(
        "/api/admin/oauth-clients",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )
    assert admin_list.status_code == 200
    assert {item["id"] for item in admin_list.json()["items"]} == {
        user_client["id"],
        admin_client["id"],
    }

    admin_disable = test_client.put(
        f"/api/admin/oauth-clients/{user_client['id']}",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={"enabled": False},
    )
    assert admin_disable.status_code == 200
    assert admin_disable.json()["is_active"] is False

    admin_create = test_client.post(
        "/api/admin/oauth-clients",
        headers={"Authorization": f"Bearer {test_admin_token}"},
        json={
            "name": "admin-created-client",
            "client_type": "public",
            "redirect_uris": ["https://client.example/callback"],
        },
    )
    assert admin_create.status_code == 405

    unauthenticated = test_client.get("/api/oauth-clients")
    assert unauthenticated.status_code == 401
