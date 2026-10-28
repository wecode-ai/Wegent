"""Cloud registration identities remain usable only on the plugin reconcile path."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints import installed_plugins as endpoints
from app.api.ws import device_namespace
from app.core import security
from app.core.config import settings
from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResponse
from app.schemas.installed_plugin import PluginDeviceSyncResponse
from app.services.device import capability_sync_service, plugin_reconciliation
from app.services.device.capability_sync_service import DeviceCapabilitySyncService
from app.services.device.runtime_route import (
    resolve_runtime_route_identity,
    runtime_route_resolver,
)
from app.services.device_service import device_service
from app.services.plugin_package_storage import plugin_package_storage
from tests.api.test_plugin_reconciliation_auth import credential, reconcile_request
from tests.api.test_plugin_write_operations import plugin_requests as plugin_requests

CLOUD_NAME = "cloud-logical"
CLOUD_SOCKET = "cloud-socket"
RUNTIME_INSTANCE = "cloud-instance"


@pytest.fixture
def cloud_reconciliation(plugin_requests, monkeypatch):
    context = plugin_requests
    context.client.app.dependency_overrides.pop(security.get_current_user)
    context.client.app.dependency_overrides.pop(endpoints._get_plugin_sync_user)
    with context.sessions.begin() as db:
        device = db.query(Kind).filter_by(kind="Device").one()
        device.name = CLOUD_NAME
        device.json = {
            "spec": {
                "deviceType": "cloud",
                "cloudConfig": {"deviceId": CLOUD_SOCKET},
            }
        }
    reconcile = AsyncMock(
        return_value=PluginDeviceSyncResponse(
            deviceId=CLOUD_NAME,
            sync=DeviceCapabilitySyncResponse(device_id=CLOUD_NAME, success=True),
        )
    )
    monkeypatch.setattr(endpoints, "reconcile_device_plugins", reconcile)
    return context, reconcile


@pytest.mark.parametrize("auth_kind", ["jwt", "api_key"])
@pytest.mark.parametrize("target", [CLOUD_NAME, CLOUD_SOCKET, f" {CLOUD_SOCKET} "])
def test_plugin_reconciliation_normalizes_owned_cloud_socket(
    cloud_reconciliation, auth_kind, target
):
    context, reconcile = cloud_reconciliation

    response = reconcile_request(context, credential(context, auth_kind), target)

    assert response.status_code == 200, response.json()
    reconcile.assert_awaited_once_with(context.user_id, CLOUD_NAME)


@pytest.mark.parametrize("auth_kind", ["jwt", "api_key"])
@pytest.mark.parametrize(
    "invalid",
    [
        "foreign",
        "inactive",
        "namespace",
        "non_cloud",
        "missing",
        "duplicate_socket",
        "name_collision",
        "duplicate_name",
    ],
)
def test_plugin_reconciliation_rejects_unowned_or_ambiguous_cloud_socket(
    cloud_reconciliation, auth_kind, invalid
):
    context, reconcile = cloud_reconciliation
    with context.sessions.begin() as db:
        device = db.query(Kind).filter_by(kind="Device").one()
        if invalid == "foreign":
            other = User(user_name="other-cloud-owner", password_hash="unused")
            db.add(other)
            db.flush()
            device.user_id = other.id
        elif invalid == "inactive":
            device.is_active = False
        elif invalid == "namespace":
            device.namespace = "other-namespace"
        elif invalid == "non_cloud":
            device.json = {
                "spec": {
                    "deviceType": "local",
                    "cloudConfig": {"deviceId": CLOUD_SOCKET},
                }
            }
        elif invalid in {"duplicate_socket", "name_collision", "duplicate_name"}:
            name = {
                "duplicate_socket": "another-cloud",
                "name_collision": CLOUD_SOCKET,
                "duplicate_name": CLOUD_NAME,
            }[invalid]
            db.add(
                Kind(
                    user_id=context.user_id,
                    kind="Device",
                    namespace="default",
                    name=name,
                    json={
                        "spec": {
                            "deviceType": (
                                "local" if invalid == "name_collision" else "cloud"
                            ),
                            "cloudConfig": {
                                "deviceId": (
                                    "different-socket"
                                    if invalid == "duplicate_name"
                                    else CLOUD_SOCKET
                                )
                            },
                        }
                    },
                )
            )
    target = "missing-socket" if invalid == "missing" else CLOUD_SOCKET

    response = reconcile_request(context, credential(context, auth_kind), target)

    assert response.status_code == 404, response.json()
    reconcile.assert_not_awaited()
    assert context.remote_calls == []


@pytest.mark.parametrize("auth_kind", ["jwt", "api_key"])
@pytest.mark.parametrize("irrelevant", ["foreign", "inactive", "namespace"])
def test_cloud_socket_uniqueness_ignores_devices_outside_active_owner_scope(
    cloud_reconciliation, auth_kind, irrelevant
):
    context, reconcile = cloud_reconciliation
    with context.sessions.begin() as db:
        other = User(user_name="other-cloud-owner", password_hash="unused")
        db.add(other)
        db.flush()
        db.add(
            Kind(
                user_id=other.id if irrelevant == "foreign" else context.user_id,
                kind="Device",
                namespace="other" if irrelevant == "namespace" else "default",
                name="other-cloud",
                is_active=irrelevant != "inactive",
                json={
                    "spec": {
                        "deviceType": "cloud",
                        "cloudConfig": {"deviceId": CLOUD_SOCKET},
                    }
                },
            )
        )

    response = reconcile_request(context, credential(context, auth_kind), CLOUD_SOCKET)

    assert response.status_code == 200, response.json()
    reconcile.assert_awaited_once_with(context.user_id, CLOUD_NAME)


@pytest.mark.parametrize("auth_kind", ["jwt", "api_key"])
@pytest.mark.parametrize("target", [CLOUD_NAME, CLOUD_SOCKET])
def test_registered_cloud_socket_reconciles_and_persists_logical_plugin_state(
    cloud_reconciliation, monkeypatch, auth_kind, target
):
    context, _ = cloud_reconciliation
    context.seed_update()
    # Unit HTTP integration must not depend on local object-storage credentials.
    for field in (
        "ATTACHMENT_S3_ENDPOINT",
        "ATTACHMENT_S3_ACCESS_KEY",
        "ATTACHMENT_S3_SECRET_KEY",
    ):
        monkeypatch.setattr(settings, field, "")
    monkeypatch.setattr(
        plugin_package_storage,
        "presign_download",
        lambda key: (
            f"https://packages.example/{key}",
            datetime.now(timezone.utc) + timedelta(hours=1),
        ),
    )

    @contextmanager
    def sessions():
        with context.sessions() as db:
            yield db

    monkeypatch.setattr(device_namespace, "get_db_session", sessions)
    match = device_namespace._match_cloud_device_sync(
        context.user_id, "198.51.100.1", CLOUD_SOCKET, RUNTIME_INSTANCE
    )
    assert match == (CLOUD_NAME, False, None)
    with context.sessions() as db:
        spec = db.query(Kind).filter_by(kind="Device").one().json["spec"]
        assert "deviceId" not in spec
        assert spec["runtimeInstanceId"] == RUNTIME_INSTANCE
        assert (
            resolve_runtime_route_identity(
                db, user_id=context.user_id, submitted_device_id=CLOUD_SOCKET
            )
            is None
        )

    monkeypatch.setattr(plugin_reconciliation, "get_db_session", sessions)
    monkeypatch.setattr(
        plugin_reconciliation,
        "device_capability_sync_service",
        DeviceCapabilitySyncService(session_factory=sessions),
    )
    monkeypatch.setattr(
        endpoints,
        "reconcile_device_plugins",
        plugin_reconciliation.reconcile_device_plugins,
    )
    monkeypatch.setattr(
        runtime_route_resolver, "_configured_session_factory", context.sessions
    )
    online_info = AsyncMock(
        return_value={
            "socket_id": "registered-cloud-sid",
            "runtime_instance_id": RUNTIME_INSTANCE,
            "runtime_features": {"pluginSync": {"protocolVersion": 2}},
        }
    )
    monkeypatch.setattr(device_service, "get_device_online_info", online_info)

    async def acknowledge(event, payload, **kwargs):
        assert event == "device:sync_capabilities"
        assert kwargs["to"] == "registered-cloud-sid"
        assert payload["device_id"] == CLOUD_SOCKET
        assert payload["scope"] == "plugins"
        assert "skills" not in payload and "mcps" not in payload
        assert len(payload["plugins"]) == 1
        plugin = payload["plugins"][0]
        return {
            "success": True,
            "scope": "plugins",
            "plugin_sync": payload["plugin_sync"],
            "plugins": [
                {
                    "id": plugin["installed_plugin_id"],
                    "name": plugin["name"],
                    "status": "synced",
                    "operation": "upsert",
                    "generation": payload["plugin_sync"]["generation"],
                    "version": plugin["version"],
                    "checksum": plugin["checksum"],
                }
            ],
        }

    rpc = AsyncMock(side_effect=acknowledge)
    monkeypatch.setattr(
        capability_sync_service, "get_sio", lambda: SimpleNamespace(call=rpc)
    )

    response = reconcile_request(context, credential(context, auth_kind), target)

    assert response.status_code == 200, response.json()
    assert response.json()["deviceId"] == CLOUD_NAME
    assert response.json()["reconciled"] is True
    rpc.assert_awaited_once()
    assert online_info.await_count >= 2
    assert all(
        call.args == (context.user_id, CLOUD_SOCKET)
        for call in online_info.await_args_list
    )
    with context.sessions() as db:
        row = db.query(PluginDeviceInstallation).one()
        assert row.user_id == context.user_id
        assert row.device_id == CLOUD_NAME
        assert row.installed_kind_id == context.installed_id
        assert row.state == "installed"
        assert row.actual_release_id == context.release_id
