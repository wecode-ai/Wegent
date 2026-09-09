import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.api.dependencies import get_db
from app.api.endpoints.plugin_connections import router
from app.core.config import settings
from app.core.security import get_current_user
from app.services.plugin_account_connections import PluginAccountAuthError


@pytest.fixture
def client(test_db, test_user):
    app = FastAPI()
    app.include_router(router, prefix="/plugin-connections")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[get_current_user] = lambda: test_user
    with TestClient(app) as client:
        yield client


def test_management_api_works_without_crypto_config(client, monkeypatch):
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_CREDENTIAL_KEYS", SecretStr(""))
    response = client.get("/plugin-connections")
    assert response.status_code == 200
    assert response.json() == []
    assert response.headers["cache-control"] == "no-store"


def test_secret_import_export_is_not_exposed_as_user_api(client):
    assert (
        client.post(
            "/plugin-connections", json={"credential": "test-secret"}
        ).status_code
        == 405
    )
    assert client.get("/plugin-connections/example/credential").status_code == 404
    assert (
        client.post("/plugin-connections/example/credential", json={}).status_code
        == 404
    )


def test_grant_nonexistent_connection_is_safe_and_not_cached(client):
    response = client.post(
        "/plugin-connections/not-owned/devices",
        json={"device_id": "any-device", "expected_revision": 1},
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "plugin_auth_connection_not_found"}
    assert response.headers["cache-control"] == "no-store"


def test_stale_write_is_reported_as_conflict(client, monkeypatch):
    def stale(*args, **kwargs):
        raise PluginAccountAuthError("plugin_auth_revision_conflict")

    monkeypatch.setattr(
        "app.api.endpoints.plugin_connections.connections.disconnect", stale
    )
    response = client.request(
        "DELETE", "/plugin-connections/connection", json={"expected_revision": 1}
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "plugin_auth_revision_conflict"


def test_management_api_requires_user_authentication():
    app = FastAPI()
    app.include_router(router, prefix="/plugin-connections")
    with TestClient(app) as client:
        assert client.get("/plugin-connections").status_code == 401


@pytest.mark.parametrize("confirmation", [{}, {"confirmed": False}])
def test_external_revocation_requires_explicit_confirmation(client, confirmation):
    response = client.post(
        "/plugin-connections/connection/confirm-provider-revocation",
        json={"expected_revision": 1, **confirmation},
    )
    assert response.status_code == 422


def test_revocation_recovery_has_no_secret_request_fields(client):
    response = client.post(
        "/plugin-connections/connection/retry-revocation",
        json={"expected_revision": 1, "device_id": "device", "credential": "synthetic"},
    )
    assert response.status_code == 422


def test_automatic_policy_defaults_on_and_persists_without_secrets(client):
    assert client.get("/plugin-connections/automation").json() == {"enabled": True}
    response = client.patch("/plugin-connections/automation", json={"enabled": False})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/plugin-connections/automation").json() == {"enabled": False}
    assert (
        client.patch(
            "/plugin-connections/automation", json={"enabled": "false"}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            "/plugin-connections/automation", json={"enabled": True, "user_id": 1}
        ).status_code
        == 422
    )
