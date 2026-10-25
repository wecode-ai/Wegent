"""Already installed plugins receive runtime-state writes on the current device."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints import installed_plugins as endpoints
from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services import plugin_device_sync, plugin_write_operations
from app.services.device.capability_sync_service import DeviceCapabilitySyncService
from app.services.device_service import device_service
from app.services.plugin_package_storage import plugin_package_storage
from app.services.plugin_write_errors import PluginWriteError
from tests.api.test_plugin_write_operations import DEVICE_ID
from tests.api.test_plugin_write_operations import plugin_requests as plugin_requests

OTHER_DEVICE_ID = "other-runtime-state-device"


@pytest.fixture
def runtime_state_sync(plugin_requests, monkeypatch):
    context = plugin_requests
    calls = []
    inventory = {DEVICE_ID: {}, OTHER_DEVICE_ID: {}}
    service = DeviceCapabilitySyncService(
        session_factory=plugin_write_operations.get_db_session
    )
    service.supports_plugin_delta = AsyncMock(return_value=True)
    monkeypatch.setattr(plugin_device_sync, "device_capability_sync_service", service)
    monkeypatch.setattr(endpoints, "device_capability_sync_service", service)
    monkeypatch.setattr(
        plugin_package_storage,
        "presign_download",
        lambda key: (
            f"https://packages.example/{key}",
            datetime.now(timezone.utc) + timedelta(hours=1),
        ),
    )

    async def rpc(*, user_id, device_id, payload, **_kwargs):
        assert user_id == context.user_id
        assert payload["mode"] == "merge"
        assert payload["scope"] == "plugin_delta"
        assert payload["plugin_sync"]["complete"] is False
        assert len(payload["plugins"]) == 1
        assert payload["removed_plugins"] == []
        assert "skills" not in payload and "mcps" not in payload
        calls.append((device_id, deepcopy(payload)))
        plugin = payload["plugins"][0]
        generation = payload["plugin_sync"]["generation"]
        inventory[device_id][plugin["installed_plugin_id"]] = {
            "generation": generation,
            "enabled": plugin["enabled"],
            "component_states": plugin.get("component_states", {}),
        }
        return DeviceCapabilitySyncResult(
            device_id=device_id,
            success=True,
            acknowledged=True,
            scope="plugin_delta",
            desired_plugin_snapshot=payload,
            plugin_sync=payload["plugin_sync"],
            plugins=[
                {
                    "id": plugin["installed_plugin_id"],
                    "status": "synced",
                    "operation": "upsert",
                    "generation": generation,
                    "version": plugin["version"],
                    "checksum": plugin.get("checksum"),
                }
            ],
        )

    service.sync_device_payload = AsyncMock(side_effect=rpc)
    response = context.write("marketplace")
    assert response.status_code == 200, response.text
    context.run_background()
    context.installed_id = response.json()["plugin"]["metadata"]["labels"]["id"]
    context.installed_id = int(context.installed_id)
    calls.clear()
    return context, calls, inventory


@pytest.fixture
def installed_runtime_state(runtime_state_sync, monkeypatch):
    context, calls, inventory = runtime_state_sync
    with context.sessions.begin() as db:
        installed = db.get(Kind, context.installed_id)
        current = (
            db.query(PluginDeviceInstallation)
            .filter_by(installed_kind_id=installed.id, device_id=DEVICE_ID)
            .one()
        )
        assert current.state == "installed"
        assert current.actual_release_id == context.release_id
        assert current.desired_release_id == context.release_id
        unrelated = Kind(
            user_id=context.user_id,
            kind="InstalledPlugin",
            namespace="default",
            name="unrelated-runtime-state-plugin",
            is_active=True,
            json=deepcopy(installed.json),
        )
        db.add(unrelated)
        db.flush()
        unrelated_id = unrelated.id
        for device_id in inventory:
            db.add(
                PluginDeviceInstallation(
                    user_id=context.user_id,
                    installed_kind_id=unrelated_id,
                    device_id=device_id,
                    desired_release_id=context.release_id,
                    actual_release_id=context.release_id,
                    state="installed",
                )
            )
            inventory[device_id][unrelated_id] = {
                "generation": 11,
                "enabled": True,
                "component_states": {},
            }
    devices = [{"device_id": device_id} for device_id in inventory]
    monkeypatch.setattr(
        device_service, "get_all_devices", AsyncMock(return_value=devices)
    )
    monkeypatch.setattr(
        device_service, "get_online_devices", AsyncMock(return_value=devices)
    )
    return context, calls, inventory, unrelated_id


@pytest.mark.parametrize(
    "changes",
    [
        {"enabled": False},
        {"componentStates": {"review": False}},
        {"enabled": False, "componentStates": {"review": False}},
    ],
)
def test_same_release_runtime_state_write_syncs_only_changed_plugin(
    installed_runtime_state, changes
):
    context, calls, inventory, unrelated_id = installed_runtime_state
    unrelated_before = deepcopy(inventory[DEVICE_ID][unrelated_id])
    for payload in (
        changes,
        {key: True if key == "enabled" else {"review": True} for key in changes},
    ):
        calls.clear()
        response = context.client.put(
            f"/plugins/installed/{context.installed_id}",
            params={"device_id": DEVICE_ID},
            json=payload,
        )

        assert response.status_code == 200, response.text
        assert [device_id for device_id, _ in calls] == [DEVICE_ID]
        sent = calls[0][1]["plugins"][0]
        assert sent["installed_plugin_id"] == context.installed_id
        assert sent["release_id"] == context.release_id
        if "enabled" in payload:
            assert (
                inventory[DEVICE_ID][context.installed_id]["enabled"]
                is payload["enabled"]
            )
        if "componentStates" in payload:
            assert (
                inventory[DEVICE_ID][context.installed_id]["component_states"]
                == payload["componentStates"]
            )
        assert len(context.background_tasks) == 1

        context.run_background()

        assert [device_id for device_id, _ in calls] == [DEVICE_ID, OTHER_DEVICE_ID]
        assert calls[1][1]["plugins"][0]["installed_plugin_id"] == context.installed_id
        for device_id in inventory:
            assert inventory[device_id][unrelated_id] == unrelated_before
            assert (
                inventory[device_id][context.installed_id]["enabled"] == sent["enabled"]
            )
            assert inventory[device_id][context.installed_id][
                "component_states"
            ] == sent.get("component_states", {})
        with context.sessions() as db:
            rows = db.query(PluginDeviceInstallation).filter_by(
                installed_kind_id=context.installed_id
            )
            assert all(row.state == "installed" for row in rows)
            assert all(row.actual_release_id == context.release_id for row in rows)


@pytest.mark.parametrize(
    "failure", [RuntimeError("device offline"), PluginWriteError("plugin_write_busy")]
)
def test_runtime_state_write_preserves_account_when_current_device_sync_fails(
    installed_runtime_state, monkeypatch, failure
):
    context, calls, inventory, unrelated_id = installed_runtime_state
    before = deepcopy(inventory[DEVICE_ID])
    failed_sync = AsyncMock(side_effect=failure)
    monkeypatch.setattr(
        plugin_device_sync.device_capability_sync_service,
        "sync_installed_plugin_to_device_result",
        failed_sync,
    )

    response = context.client.put(
        f"/plugins/installed/{context.installed_id}",
        params={"device_id": DEVICE_ID},
        json={"enabled": False},
    )

    assert response.status_code == 200, response.text
    assert response.json()["spec"]["enabled"] is False
    with context.sessions() as db:
        assert db.get(Kind, context.installed_id).json["spec"]["enabled"] is False
    failed_sync.assert_awaited_once()
    assert inventory[DEVICE_ID] == before
    context.run_background()
    assert [device_id for device_id, _ in calls] == [OTHER_DEVICE_ID]
    assert inventory[OTHER_DEVICE_ID][context.installed_id]["enabled"] is False
    assert inventory[OTHER_DEVICE_ID][unrelated_id] == before[unrelated_id]


def test_repeated_install_still_skips_current_device_when_same_release_is_installed(
    installed_runtime_state,
):
    context, calls, inventory, _unrelated_id = installed_runtime_state
    before = deepcopy(inventory[DEVICE_ID])

    response = context.write("marketplace")

    assert response.status_code == 200, response.text
    assert calls == []
    context.run_background()
    assert [device_id for device_id, _ in calls] == [OTHER_DEVICE_ID]
    assert inventory[DEVICE_ID] == before


@pytest.mark.parametrize(
    "preference",
    [
        {"enabled": False},
        {"componentStates": {"review": False}},
        {"updatePolicy": "manual"},
    ],
)
def test_repeated_install_preserves_existing_preferences(
    runtime_state_sync, preference
):
    context, calls, inventory = runtime_state_sync
    updated = context.client.put(
        f"/plugins/installed/{context.installed_id}",
        params={"device_id": DEVICE_ID},
        json=preference,
    )
    assert updated.status_code == 200, updated.text
    context.run_background()
    before = deepcopy(inventory[DEVICE_ID])
    calls.clear()

    response = context.write("marketplace")

    assert response.status_code == 200, response.text
    installed = response.json()["plugin"]
    assert int(installed["metadata"]["labels"]["id"]) == context.installed_id
    for key, value in preference.items():
        assert installed["spec"][key] == value
    assert calls == []
    assert inventory[DEVICE_ID] == before
    context.run_background()
    assert inventory[DEVICE_ID] == before


def test_failed_plugin_ack_records_failure_after_account_release_commit(
    runtime_state_sync, monkeypatch
):
    context, _calls, inventory = runtime_state_sync
    before = deepcopy(inventory[DEVICE_ID])

    async def reject_package(*, device_id, payload, **_kwargs):
        plugin = payload["plugins"][0]
        return DeviceCapabilitySyncResult(
            device_id=device_id,
            success=False,
            acknowledged=True,
            scope="plugin_delta",
            desired_plugin_snapshot=deepcopy(payload),
            plugin_sync=payload["plugin_sync"],
            error="Download checksum mismatch",
            plugins=[
                {
                    "id": plugin["installed_plugin_id"],
                    "status": "failed",
                    "operation": "upsert",
                    "generation": payload["plugin_sync"]["generation"],
                    "error_code": "CHECKSUM_MISMATCH",
                    "error": "Download checksum mismatch",
                }
            ],
        )

    monkeypatch.setattr(
        plugin_device_sync.device_capability_sync_service,
        "sync_device_payload",
        AsyncMock(side_effect=reject_package),
    )

    response = context.client.put(
        f"/plugins/installed/{context.installed_id}",
        params={"device_id": DEVICE_ID},
        json={"releaseId": context.upgraded_release_id},
    )

    assert response.status_code == 200, response.text
    assert response.json()["spec"]["releaseId"] == context.upgraded_release_id
    assert inventory[DEVICE_ID] == before
    with context.sessions() as db:
        installed = db.get(Kind, context.installed_id)
        assert installed.json["spec"]["releaseId"] == context.upgraded_release_id
        row = (
            db.query(PluginDeviceInstallation)
            .filter_by(installed_kind_id=context.installed_id, device_id=DEVICE_ID)
            .one()
        )
        assert row.state == "failed"
        assert row.attempt_count == 1
        assert row.error_code == "CHECKSUM_MISMATCH"
        assert row.error_message == "Download checksum mismatch"
        assert row.actual_release_id == context.release_id
        assert row.desired_release_id == context.upgraded_release_id
    context.run_background()
