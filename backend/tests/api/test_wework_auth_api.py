from fastapi.testclient import TestClient

from app.api.endpoints import wework_auth
from app.core.config import settings


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


def test_create_wework_auth_session_uses_dedicated_authorize_base_url(
    test_client: TestClient,
    monkeypatch,
):
    install_memory_auth_session_cache(monkeypatch)
    monkeypatch.setattr(
        settings, "WEWORK_AUTHORIZE_BASE_URL", "https://app.example.com"
    )
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://frontend.example.com")

    response = test_client.post("/api/auth/wework/sessions")

    assert response.status_code == 200
    data = response.json()
    assert data["authorize_url"].startswith(
        "https://app.example.com/auth/wework/authorize?"
    )
    assert data["session_id"]
    assert data["poll_token"]
    assert data["poll_interval_seconds"] > 0


def test_wework_auth_session_approve_and_poll_returns_token_once(
    test_client: TestClient,
    test_token: str,
    test_user,
    monkeypatch,
):
    install_memory_auth_session_cache(monkeypatch)
    monkeypatch.setattr(settings, "WEWORK_AUTHORIZE_BASE_URL", "")
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://frontend.example.com")
    session_response = test_client.post("/api/auth/wework/sessions")
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
    session_response = test_client.post("/api/auth/wework/sessions")
    assert session_response.status_code == 200
    session = session_response.json()

    poll_response = test_client.get(
        f"/api/auth/wework/sessions/{session['session_id']}/poll",
        params={"poll_token": "wrong-token"},
    )

    assert poll_response.status_code == 401
