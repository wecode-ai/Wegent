"""Device credentials authorize only plugin reconciliation on owned devices."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints import installed_plugins as endpoints
from app.core import security
from app.models.api_key import KEY_TYPE_PLUGIN_RELEASE, KEY_TYPE_SERVICE, APIKey
from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResponse
from app.schemas.installed_plugin import PluginDeviceSyncResponse
from app.services.api_key_service import create_api_key_for_remote_device
from tests.api.test_plugin_write_operations import DEVICE_ID, PluginRequests
from tests.api.test_plugin_write_operations import plugin_requests as plugin_requests


@pytest.fixture
def reconciliation_auth(plugin_requests, monkeypatch):
    context = plugin_requests
    context.client.app.dependency_overrides.pop(security.get_current_user)
    context.client.app.dependency_overrides.pop(endpoints._get_plugin_sync_user)
    reconcile = AsyncMock(
        return_value=PluginDeviceSyncResponse(
            deviceId=DEVICE_ID,
            sync=DeviceCapabilitySyncResponse(device_id=DEVICE_ID, success=True),
        )
    )
    monkeypatch.setattr(endpoints, "reconcile_device_plugins", reconcile)
    return context, reconcile


def credential(context: PluginRequests, kind: str) -> str:
    with context.sessions() as db:
        user = db.get(User, context.user_id)
        if kind == "jwt":
            return security.create_access_token({"sub": user.user_name})
        _, token = create_api_key_for_remote_device(db, user.id, user.user_name)
        return token


def reconcile_request(context: PluginRequests, token: str, device_id: str = DEVICE_ID):
    return context.client.post(
        "/plugins/installed/sync-device",
        params={"device_id": device_id, "reconcile": "true"},
        headers={"Authorization": f"Bearer {token}"} if token else {},
    )


@pytest.mark.parametrize("auth_kind", ["jwt", "api_key"])
@pytest.mark.parametrize("device_type", ["local", "app", "cloud", "remote"])
def test_owned_runtime_accepts_user_session_and_remote_device_key(
    reconciliation_auth, auth_kind, device_type
):
    context, reconcile = reconciliation_auth
    device_id = DEVICE_ID
    with context.sessions.begin() as db:
        device = db.query(Kind).filter_by(kind="Device").one()
        device.json = {"spec": {"deviceType": device_type, "deviceId": DEVICE_ID}}
        if device_type == "app":
            device_id = f"app-record-{device.id}"

    response = reconcile_request(context, credential(context, auth_kind), device_id)

    assert response.status_code == 200, response.json()
    reconcile.assert_awaited_once_with(context.user_id, device_id)
    assert context.remote_calls == []


@pytest.mark.parametrize("auth_kind", ["jwt", "api_key"])
@pytest.mark.parametrize("target", ["foreign", "inactive", "namespace", "missing"])
def test_reconciliation_rejects_devices_outside_active_owner_scope(
    reconciliation_auth, auth_kind, target
):
    context, reconcile = reconciliation_auth
    with context.sessions.begin() as db:
        device = db.query(Kind).filter_by(kind="Device").one()
        device.json = {"spec": {"deviceType": "app", "deviceId": DEVICE_ID}}
        if target == "foreign":
            other = User(user_name="other-plugin-owner", password_hash="unused")
            db.add(other)
            db.flush()
            device.user_id = other.id
        elif target == "inactive":
            device.is_active = False
        elif target == "namespace":
            device.namespace = "other-namespace"
        device_id = f"app-record-{device.id}" if target != "missing" else "missing"

    response = reconcile_request(context, credential(context, auth_kind), device_id)

    assert response.status_code == 404, response.json()
    reconcile.assert_not_awaited()
    assert context.remote_calls == []


@pytest.mark.parametrize(
    "invalid",
    [
        "missing",
        "unknown_key",
        "invalid_jwt",
        "expired",
        "revoked",
        "inactive_user",
        KEY_TYPE_SERVICE,
        KEY_TYPE_PLUGIN_RELEASE,
    ],
)
def test_invalid_credentials_cannot_start_plugin_reconciliation(
    reconciliation_auth, invalid
):
    context, reconcile = reconciliation_auth
    token = credential(context, "api_key")
    if invalid in {"missing", "unknown_key", "invalid_jwt"}:
        token = {"missing": "", "unknown_key": "wg-unknown", "invalid_jwt": "bad"}[
            invalid
        ]
    else:
        with context.sessions.begin() as db:
            key = db.query(APIKey).one()
            if invalid == "expired":
                key.expires_at = datetime.utcnow() - timedelta(seconds=1)
            elif invalid == "revoked":
                key.is_active = False
            elif invalid == "inactive_user":
                db.get(User, context.user_id).is_active = False
            else:
                key.key_type = invalid

    response = reconcile_request(context, token)

    assert response.status_code == 401, response.json()
    reconcile.assert_not_awaited()


@pytest.mark.parametrize("reconcile", [None, "false"])
def test_device_key_cannot_authorize_full_capability_replacement(
    reconciliation_auth, reconcile
):
    context, plugin_reconcile = reconciliation_auth
    params = {"device_id": DEVICE_ID}
    if reconcile is not None:
        params["reconcile"] = reconcile

    response = context.client.post(
        "/plugins/installed/sync-device",
        params=params,
        headers={"Authorization": f"Bearer {credential(context, 'api_key')}"},
    )

    assert response.status_code == 401, response.json()
    plugin_reconcile.assert_not_awaited()
    assert context.remote_calls == []


def test_user_session_still_authorizes_explicit_full_capability_sync(
    reconciliation_auth,
):
    context, reconcile = reconciliation_auth

    response = context.client.post(
        "/plugins/installed/sync-device",
        params={"device_id": DEVICE_ID},
        headers={"Authorization": f"Bearer {credential(context, 'jwt')}"},
    )

    assert response.status_code == 200, response.json()
    assert context.remote_calls == ["recovery"]
    reconcile.assert_not_awaited()


def test_device_key_does_not_authorize_other_plugin_writes(reconciliation_auth):
    context, reconcile = reconciliation_auth

    response = context.client.post(
        f"/plugins/marketplace/{context.plugin_id}/install",
        params={"device_id": DEVICE_ID},
        headers={"Authorization": f"Bearer {credential(context, 'api_key')}"},
    )

    assert response.status_code == 401, response.json()
    assert context.account() is None
    reconcile.assert_not_awaited()
