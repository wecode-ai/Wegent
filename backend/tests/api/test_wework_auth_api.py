import base64
import hashlib
import time
import uuid

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from jose import jwt

from app.api.endpoints import wework_auth
from app.core.config import settings
from app.core.security import verify_token


class MemoryAuthSessionCache:
    def __init__(self):
        self.values: dict[str, dict] = {}

    async def set(self, key: str, value: dict, expire: int | None = None) -> bool:
        self.values[key] = dict(value)
        return True

    async def get(self, key: str):
        value = self.values.get(key)
        return dict(value) if value is not None else None


def install_memory_auth_session_cache(monkeypatch) -> MemoryAuthSessionCache:
    cache = MemoryAuthSessionCache()
    monkeypatch.setattr(wework_auth, "cache_manager", cache)
    return cache


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def device_identity():
    private_key = ec.generate_private_key(ec.SECP256R1())
    numbers = private_key.public_key().public_numbers()
    public_jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": base64url(numbers.x.to_bytes(32, "big")),
        "y": base64url(numbers.y.to_bytes(32, "big")),
    }
    return private_key, public_jwk


def create_session(test_client: TestClient, public_jwk: dict[str, str]):
    return test_client.post(
        "/api/auth/wework/sessions",
        json={"device_public_key": public_jwk},
    )


def create_legacy_session(test_client: TestClient):
    return test_client.post("/api/auth/wework/sessions")


def device_proof(
    private_key,
    public_jwk: dict[str, str],
    refresh_token: str,
    path: str = "/api/auth/wework/refresh",
) -> str:
    return jwt.encode(
        {
            "htm": "POST",
            "htu": path,
            "iat": int(time.time()),
            "jti": str(uuid.uuid4()),
            "ath": base64url(hashlib.sha256(refresh_token.encode()).digest()),
        },
        private_key,
        algorithm="ES256",
        headers={"jwk": public_jwk},
    )


def test_wework_config_exposes_wegent_frontend_url(
    test_client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://frontend.example.com/")
    monkeypatch.setattr(settings, "WEGENT_SOCKET_URL", "wss://socket.example.com/")

    response = test_client.get("/api/auth/wework/config")

    assert response.status_code == 200
    assert response.json() == {
        "web_url": "https://frontend.example.com",
        "socket_url": "wss://socket.example.com",
    }


def test_wework_config_returns_null_for_unconfigured_socket_url(
    test_client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://frontend.example.com")
    monkeypatch.setattr(settings, "WEGENT_SOCKET_URL", "")

    response = test_client.get("/api/auth/wework/config")

    assert response.status_code == 200
    assert response.json() == {
        "web_url": "https://frontend.example.com",
        "socket_url": None,
    }


def test_create_wework_auth_session_uses_dedicated_authorize_base_url(
    test_client: TestClient,
    monkeypatch,
):
    install_memory_auth_session_cache(monkeypatch)
    monkeypatch.setattr(
        settings, "WEWORK_AUTHORIZE_BASE_URL", "https://app.example.com"
    )
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://frontend.example.com")

    _, public_jwk = device_identity()
    response = create_session(test_client, public_jwk)

    assert response.status_code == 200
    data = response.json()
    assert data["authorize_url"].startswith(
        "https://app.example.com/auth/wework/authorize?"
    )
    assert data["web_url"] == "https://frontend.example.com"
    assert data["session_id"]
    assert data["poll_token"]
    assert data["poll_interval_seconds"] > 0


def test_legacy_wework_auth_session_works_without_a_request_body(
    test_client: TestClient,
    test_token: str,
    test_user,
    monkeypatch,
):
    install_memory_auth_session_cache(monkeypatch)
    session_response = create_legacy_session(test_client)

    assert session_response.status_code == 200
    session = session_response.json()

    approve_response = test_client.post(
        f"/api/auth/wework/sessions/{session['session_id']}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert approve_response.status_code == 200

    poll_response = test_client.get(
        f"/api/auth/wework/sessions/{session['session_id']}/poll",
        params={"poll_token": session["poll_token"]},
    )

    assert poll_response.status_code == 200
    credentials = poll_response.json()
    assert credentials["status"] == "success"
    assert credentials["access_token"]
    assert credentials["refresh_token"] is None
    payload = jwt.decode(
        credentials["access_token"],
        settings.SECRET_KEY,
        algorithms=[settings.ALGORITHM],
    )
    assert payload["sub"] == test_user.user_name
    assert "token_use" not in payload
    assert payload["exp"] - int(time.time()) > 6 * 24 * 60 * 60

    authenticated = test_client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {credentials['access_token']}"},
    )
    assert authenticated.status_code == 200
    assert authenticated.json()["user_name"] == test_user.user_name


def test_wework_auth_session_approve_and_poll_returns_token_once(
    test_client: TestClient,
    test_token: str,
    test_user,
    monkeypatch,
):
    install_memory_auth_session_cache(monkeypatch)
    monkeypatch.setattr(settings, "WEWORK_AUTHORIZE_BASE_URL", "")
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://frontend.example.com")
    _, public_jwk = device_identity()
    session_response = create_session(test_client, public_jwk)
    assert session_response.status_code == 200
    session = session_response.json()
    assert session["authorize_url"].startswith(
        "https://frontend.example.com/auth/wework/authorize?"
    )

    approve_response = test_client.post(
        f"/api/auth/wework/sessions/{session['session_id']}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert approve_response.status_code == 200
    assert approve_response.json()["status"] == "approved"

    poll_response = test_client.get(
        f"/api/auth/wework/sessions/{session['session_id']}/poll",
        params={"poll_token": session["poll_token"]},
    )
    assert poll_response.status_code == 200
    poll_data = poll_response.json()
    assert poll_data["status"] == "success"
    assert poll_data["access_token"]
    assert poll_data["refresh_token"]
    assert poll_data["token_type"] == "bearer"
    assert poll_data["username"] == test_user.user_name

    second_poll_response = test_client.get(
        f"/api/auth/wework/sessions/{session['session_id']}/poll",
        params={"poll_token": session["poll_token"]},
    )
    assert second_poll_response.status_code == 200
    assert second_poll_response.json()["status"] == "failed"


def test_wework_auth_session_rejects_invalid_poll_token(
    test_client: TestClient, monkeypatch
):
    install_memory_auth_session_cache(monkeypatch)
    monkeypatch.setattr(
        settings, "WEWORK_AUTHORIZE_BASE_URL", "https://app.example.com"
    )
    _, public_jwk = device_identity()
    session_response = create_session(test_client, public_jwk)
    assert session_response.status_code == 200
    session = session_response.json()

    poll_response = test_client.get(
        f"/api/auth/wework/sessions/{session['session_id']}/poll",
        params={"poll_token": "wrong-token"},
    )

    assert poll_response.status_code == 401


def test_device_bound_session_does_not_downgrade_when_binding_is_missing(
    test_client: TestClient,
    test_token: str,
    monkeypatch,
):
    cache = install_memory_auth_session_cache(monkeypatch)
    _, public_jwk = device_identity()
    session = create_session(test_client, public_jwk).json()
    cached_session = cache.values[wework_auth._session_key(session["session_id"])]
    cached_session.pop("device_thumbprint")

    approve_response = test_client.post(
        f"/api/auth/wework/sessions/{session['session_id']}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert approve_response.status_code == 500
    assert approve_response.json()["detail"] == (
        "Authorization session is missing its device binding"
    )


def test_wework_refresh_requires_the_bound_device_key(
    test_client: TestClient,
    test_token: str,
    monkeypatch,
):
    install_memory_auth_session_cache(monkeypatch)
    private_key, public_jwk = device_identity()
    session = create_session(test_client, public_jwk).json()
    approve = test_client.post(
        f"/api/auth/wework/sessions/{session['session_id']}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert approve.status_code == 200
    credentials = test_client.get(
        f"/api/auth/wework/sessions/{session['session_id']}/poll",
        params={"poll_token": session["poll_token"]},
    ).json()

    refreshed = test_client.post(
        "/api/auth/wework/refresh",
        json={
            "refresh_token": credentials["refresh_token"],
            "proof": device_proof(
                private_key,
                public_jwk,
                credentials["refresh_token"],
            ),
        },
    )

    assert refreshed.status_code == 200
    assert verify_token(refreshed.json()["access_token"])["username"]

    wrong_private_key, wrong_public_jwk = device_identity()
    rejected = test_client.post(
        "/api/auth/wework/refresh",
        json={
            "refresh_token": credentials["refresh_token"],
            "proof": device_proof(
                wrong_private_key,
                wrong_public_jwk,
                credentials["refresh_token"],
            ),
        },
    )
    assert rejected.status_code == 401


def test_wework_refresh_token_cannot_authenticate_regular_api(
    test_client: TestClient,
    test_token: str,
    monkeypatch,
):
    install_memory_auth_session_cache(monkeypatch)
    _, public_jwk = device_identity()
    session = create_session(test_client, public_jwk).json()
    test_client.post(
        f"/api/auth/wework/sessions/{session['session_id']}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    credentials = test_client.get(
        f"/api/auth/wework/sessions/{session['session_id']}/poll",
        params={"poll_token": session["poll_token"]},
    ).json()

    response = test_client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {credentials['refresh_token']}"},
    )

    assert response.status_code == 401
