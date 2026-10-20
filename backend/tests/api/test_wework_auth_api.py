import base64
import hashlib
import json
import time
import uuid

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.api.endpoints import wework_auth


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


def seed_device_bound_session(
    cache: MemoryAuthSessionCache, public_jwk: dict[str, str]
) -> dict[str, str]:
    session_id = str(uuid.uuid4())
    device_public_key = public_jwk
    thumbprint_payload = json.dumps(
        {key: device_public_key[key] for key in ("crv", "kty", "x", "y")},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    cache.values[wework_auth._session_key(session_id)] = {
        "status": "pending",
        "auth_mode": wework_auth.DEVICE_BOUND_REFRESH_AUTH_MODE,
        "poll_token": "poll-token",
        "created_at": int(time.time()),
        "expires_at": int(time.time()) + wework_auth.SESSION_TTL_SECONDS,
        "device_public_key": device_public_key,
        "device_thumbprint": base64url(hashlib.sha256(thumbprint_payload).digest()),
    }
    return {"session_id": session_id, "poll_token": "poll-token"}


def test_wework_auth_session_approve_persists_device_bound_tokens(
    test_client: TestClient,
    test_token: str,
    test_user,
    monkeypatch,
):
    cache = install_memory_auth_session_cache(monkeypatch)
    _, public_jwk = device_identity()
    session = seed_device_bound_session(cache, public_jwk)

    approve_response = test_client.post(
        f"/api/auth/wework/sessions/{session['session_id']}/approve",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert approve_response.status_code == 200
    assert approve_response.json()["status"] == "approved"

    stored = cache.values[wework_auth._session_key(session["session_id"])]
    assert stored["status"] == "approved"
    assert stored["access_token"]
    assert stored["refresh_token"]
    assert stored["username"] == test_user.user_name


def test_device_bound_session_does_not_downgrade_when_binding_is_missing(
    test_client: TestClient,
    test_token: str,
    monkeypatch,
):
    cache = install_memory_auth_session_cache(monkeypatch)
    _, public_jwk = device_identity()
    session = seed_device_bound_session(cache, public_jwk)
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
