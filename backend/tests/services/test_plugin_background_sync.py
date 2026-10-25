"""Account plugin changes converge without replacing unrelated device state."""

import asyncio
from contextlib import contextmanager
from copy import deepcopy
from unittest.mock import AsyncMock, Mock

import pytest

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services import plugin_device_sync, plugin_write_operations
from app.services.device import plugin_change_sync
from app.services.device.capability_sync_service import DeviceCapabilitySyncService
from tests.services.test_plugin_marketplace_v2 import _device_install

pytestmark = pytest.mark.usefixtures("plugin_write_sessions")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "current_alias", ["route", "runtime-current", "electron-current"]
)
async def test_background_excludes_current_app_aliases_and_deduplicates_other_apps(
    test_db, test_user, monkeypatch, current_alias
):
    devices = [
        Kind(
            user_id=test_user.id,
            kind="Device",
            namespace="default",
            name=f"runtime-{name}",
            is_active=True,
            json={"spec": {"deviceType": "app", "appDeviceId": f"electron-{name}"}},
        )
        for name in ("current", "other")
    ]
    test_db.add_all(devices)
    test_db.commit()
    current_route, other_route = [f"app-record-{device.id}" for device in devices]
    closed = False

    @contextmanager
    def session():
        nonlocal closed
        with plugin_write_operations.get_db_session() as db:
            yield db
        closed = True

    async def online_devices(db, user_id):
        assert db is not test_db
        assert user_id == test_user.id
        return [
            {"device_id": identity}
            for identity in (
                current_route,
                "runtime-current",
                "electron-current",
                other_route,
                "runtime-other",
                "electron-other",
            )
        ] + [{}]

    def schedule(*_args, **_kwargs):
        assert closed

    dispatch = Mock(side_effect=schedule)
    monkeypatch.setattr(plugin_device_sync, "get_db_session", session)
    monkeypatch.setattr(
        plugin_device_sync.device_service, "get_online_devices", online_devices
    )
    monkeypatch.setattr(plugin_device_sync, "schedule_other_devices", dispatch)

    await plugin_device_sync.sync_plugin_to_other_devices_after_change(
        test_user.id, 17, current_route if current_alias == "route" else current_alias
    )

    dispatch.assert_called_once_with(
        plugin_device_sync.device_capability_sync_service,
        user_id=test_user.id,
        device_ids=[other_route],
        installed_plugin_ids=[17],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("current_alias", ["cloud-current", "cloud-socket-current"])
async def test_background_excludes_current_cloud_connection_alias(
    test_db, test_user, monkeypatch, current_alias
):
    devices = [
        Kind(
            user_id=test_user.id,
            kind="Device",
            namespace="default",
            name=f"cloud-{name}",
            is_active=True,
            json={
                "spec": {
                    "deviceType": "cloud",
                    "cloudConfig": {"deviceId": f"cloud-socket-{name}"},
                }
            },
        )
        for name in ("current", "other")
    ]
    test_db.add_all(devices)
    test_db.commit()
    monkeypatch.setattr(
        plugin_device_sync, "get_db_session", plugin_write_operations.get_db_session
    )
    monkeypatch.setattr(
        plugin_device_sync.device_service,
        "get_online_devices",
        AsyncMock(
            return_value=[
                {"device_id": "cloud-current"},
                {"device_id": "cloud-socket-current"},
                {"device_id": "cloud-other"},
                {"device_id": "cloud-other"},
            ]
        ),
    )
    schedule = Mock()
    monkeypatch.setattr(plugin_device_sync, "schedule_other_devices", schedule)

    await plugin_device_sync.sync_plugin_to_other_devices_after_change(
        test_user.id, 17, current_alias
    )

    schedule.assert_called_once_with(
        plugin_device_sync.device_capability_sync_service,
        user_id=test_user.id,
        device_ids=["cloud-other"],
        installed_plugin_ids=[17],
    )


@pytest.mark.asyncio
async def test_background_dispatch_preserves_unrelated_inventory_and_generation(
    test_db, test_user, monkeypatch
):
    installed, release = _device_install(test_db, test_user.id)
    installed_id, release_id, user_id = installed.id, release.id, test_user.id
    unrelated = Kind(
        user_id=user_id,
        kind="InstalledPlugin",
        namespace="default",
        name="pending-removal",
        is_active=False,
        json={"spec": {"releaseId": release_id}},
    )
    test_db.add(unrelated)
    test_db.flush()
    unrelated_id = unrelated.id
    test_db.add(
        PluginDeviceInstallation(
            user_id=user_id,
            installed_kind_id=unrelated_id,
            device_id="other",
            desired_release_id=release_id,
            actual_release_id=release_id,
            state="uninstalling",
            attempt_count=2,
            error_message="pending removal",
        )
    )
    test_db.add(
        Kind(
            user_id=user_id,
            kind="PluginSyncState",
            namespace="plugin-sync",
            name="account",
            is_active=True,
            json={"spec": {"generation": 16}},
        )
    )
    test_db.commit()
    inventory = {
        "current": {installed_id: {"generation": 11}},
        "other": {
            unrelated_id: {"generation": 11, "version": "1.0.0"},
            "skills": ["preserved-skill"],
            "mcps": ["preserved-mcp"],
        },
    }
    before = deepcopy(inventory)
    service = DeviceCapabilitySyncService(
        session_factory=plugin_write_operations.get_db_session
    )
    service.supports_plugin_delta = AsyncMock(return_value=True)

    async def rpc(*, user_id, device_id, payload, **_kwargs):
        assert device_id == "other"
        assert payload["mode"] == "merge"
        assert payload["scope"] == "plugin_delta"
        assert payload["plugin_sync"]["complete"] is False
        assert [item["installed_plugin_id"] for item in payload["plugins"]] == [
            installed_id
        ]
        assert payload["removed_plugins"] == []
        assert "skills" not in payload and "mcps" not in payload
        generation = payload["plugin_sync"]["generation"]
        plugin = payload["plugins"][0]
        inventory[device_id][installed_id] = {"generation": generation}
        return DeviceCapabilitySyncResult(
            device_id=device_id,
            success=True,
            acknowledged=True,
            scope="plugin_delta",
            desired_plugin_snapshot=payload,
            plugin_sync=payload["plugin_sync"],
            plugins=[
                {
                    "id": installed_id,
                    "status": "synced",
                    "operation": "upsert",
                    "generation": generation,
                    "version": plugin["version"],
                    "checksum": plugin.get("checksum"),
                }
            ],
        )

    service.sync_device_payload = AsyncMock(side_effect=rpc)
    monkeypatch.setattr(plugin_device_sync, "device_capability_sync_service", service)
    monkeypatch.setattr(
        plugin_device_sync, "get_db_session", plugin_write_operations.get_db_session
    )
    monkeypatch.setattr(
        plugin_device_sync.device_service,
        "get_online_devices",
        AsyncMock(return_value=[{"device_id": "current"}, {"device_id": "other"}]),
    )

    await plugin_device_sync.sync_plugin_to_other_devices_after_change(
        user_id, installed_id, "current"
    )
    await asyncio.gather(*list(plugin_change_sync._background))

    service.sync_device_payload.assert_awaited_once()
    assert inventory["current"] == before["current"]
    assert inventory["other"][installed_id] == {"generation": 17}
    assert inventory["other"][unrelated_id] == before["other"][unrelated_id]
    assert inventory["other"]["skills"] == before["other"]["skills"]
    assert inventory["other"]["mcps"] == before["other"]["mcps"]
    test_db.expire_all()
    rows = {
        row.installed_kind_id: row
        for row in test_db.query(PluginDeviceInstallation).all()
    }
    assert rows[installed_id].state == "installed"
    assert rows[installed_id].actual_release_id == release_id
    assert rows[unrelated_id].state == "uninstalling"
    assert rows[unrelated_id].attempt_count == 2
    assert rows[unrelated_id].error_message == "pending removal"


@pytest.mark.asyncio
async def test_background_failure_isolated_from_slow_device_and_request_session(
    test_db, test_user, monkeypatch, caplog
):
    started = asyncio.Event()
    release = asyncio.Event()
    enumerated_sessions = []

    async def online_devices(db, user_id):
        enumerated_sessions.append(db)
        return [{"device_id": "failed"}, {"device_id": "slow"}]

    async def sync_change(*, user_id, device_id, installed_plugin_ids):
        assert installed_plugin_ids == [17]
        if device_id == "failed":
            raise RuntimeError("device disconnected")
        started.set()
        await release.wait()
        return DeviceCapabilitySyncResult(device_id=device_id, success=True)

    service = DeviceCapabilitySyncService()
    service.sync_plugin_change = AsyncMock(side_effect=sync_change)
    record = Mock()
    monkeypatch.setattr(plugin_device_sync, "device_capability_sync_service", service)
    monkeypatch.setattr(
        plugin_device_sync, "get_db_session", plugin_write_operations.get_db_session
    )
    monkeypatch.setattr(
        plugin_device_sync.device_service, "get_online_devices", online_devices
    )
    monkeypatch.setattr(
        plugin_device_sync.plugin_device_installation_service,
        "record_device_sync_result",
        record,
    )

    try:
        await asyncio.wait_for(
            plugin_device_sync.sync_plugin_to_other_devices_after_change(
                test_user.id, 17, "current"
            ),
            timeout=2,
        )
        await asyncio.wait_for(started.wait(), timeout=2)
        assert release.is_set() is False
        record.assert_not_called()
    finally:
        pending = list(plugin_change_sync._background)
        release.set()
        await asyncio.gather(*pending)

    assert "device_id=failed" in caplog.text
    record.assert_called_once()
    assert record.call_args.kwargs["result"].device_id == "slow"
    assert record.call_args.kwargs["db"] is not test_db
    assert record.call_args.kwargs["db"] is not enumerated_sessions[0]
