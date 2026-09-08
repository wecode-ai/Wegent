"""Regression coverage for desktop aliases sharing one plugin installation."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints.installed_plugins import _ensure_installed_plugin_on_device
from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilityItemResult, DeviceCapabilitySyncResult
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.plugin_device_identity import (
    plugin_device_id,
    plugin_device_rows,
    reconcile_plugin_device_rows,
)
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service
from tests.services.test_plugin_marketplace_v2 import _device_install


@pytest.fixture
def alias_install(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    test_db.add(
        Kind(
            user_id=test_user.id,
            namespace="default",
            kind="Device",
            name="runtime-device",
            is_active=True,
            json={
                "spec": {
                    "deviceType": "remote",
                    "deviceId": "runtime-device",
                    "appDeviceId": "electron-app",
                }
            },
        )
    )
    now = datetime.now()
    for device_id, actual, timestamp in (
        ("electron-app", 0, now - timedelta(minutes=1)),
        ("runtime-device", release.id, now),
    ):
        test_db.add(
            PluginDeviceInstallation(
                user_id=test_user.id,
                installed_kind_id=installed.id,
                device_id=device_id,
                desired_release_id=release.id,
                actual_release_id=actual,
                state="installed",
                last_sync_at=timestamp,
            )
        )
    test_db.commit()
    return installed, release


def test_marketplace_alias_uses_latest_device_state_without_writing(
    test_db, test_user, alias_install
):
    installed, release = alias_install
    item = plugin_marketplace_service.get_plugin(
        test_db,
        user_id=test_user.id,
        plugin_id=release.plugin_id,
        device_id="electron-app",
    )
    assert item.installed
    assert not item.updateAvailable
    assert item.currentDeviceInstallation.deviceId == "electron-app"
    assert item.currentDeviceInstallation.actualReleaseId == release.id
    assert test_db.query(PluginDeviceInstallation).count() == 2


def test_sync_through_alias_converges_legacy_records(test_db, test_user, alias_install):
    installed, release = alias_install
    plugin_device_installation_service.record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="electron-app",
            success=True,
            plugins=[
                DeviceCapabilityItemResult(
                    id=str(installed.id), name="device-state", status="synced"
                )
            ],
        ),
    )
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.device_id == "runtime-device"
    assert row.actual_release_id == release.id
    assert row.state == "installed"


def test_alias_repair_preserves_latest_failure_and_retry_count(
    test_db, test_user, alias_install
):
    installed, release = alias_install
    alias = (
        test_db.query(PluginDeviceInstallation)
        .filter_by(device_id="electron-app")
        .one()
    )
    alias.last_sync_at = datetime.now() + timedelta(seconds=1)
    alias.state = "failed"
    alias.actual_release_id = release.id
    alias.desired_release_id = release.id + 1
    alias.attempt_count = 3
    alias.error_message = "download rejected"
    test_db.commit()
    reconcile_plugin_device_rows(test_db, test_user.id)
    row = test_db.query(PluginDeviceInstallation).one()
    assert row.device_id == "runtime-device"
    assert (row.state, row.attempt_count, row.error_message) == (
        "failed",
        3,
        "download rejected",
    )
    assert row.actual_release_id == release.id


def test_alias_resolution_does_not_read_another_users_install(
    test_db, test_user, alias_install
):
    assert not plugin_device_rows(test_db, test_user.id + 1, "electron-app")


def test_app_record_route_and_legacy_aliases_share_installation(
    test_db, test_user, alias_install
):
    installed, release = alias_install
    device = test_db.query(Kind).filter_by(kind="Device", name="runtime-device").one()
    device.json = {"spec": {"deviceType": "app", "appDeviceId": "electron-app"}}
    test_db.commit()
    route = f"app-record-{device.id}"
    for alias in (route, "runtime-device", "electron-app"):
        assert plugin_device_id(test_db, test_user.id, alias) == route
        assert (
            plugin_device_rows(test_db, test_user.id, alias)[
                installed.id
            ].actual_release_id
            == release.id
        )
    reconcile_plugin_device_rows(test_db, test_user.id)
    assert test_db.query(PluginDeviceInstallation).one().device_id == route


@pytest.mark.asyncio
async def test_installed_state_without_target_release_still_syncs(
    test_db, test_user, alias_install, monkeypatch
):
    installed, release = alias_install
    for row in test_db.query(PluginDeviceInstallation).all():
        row.actual_release_id = 0
    test_db.commit()
    sync = AsyncMock(side_effect=RuntimeError("offline"))
    monkeypatch.setattr(
        device_capability_sync_service, "sync_installed_plugin_to_device", sync
    )
    await _ensure_installed_plugin_on_device(
        test_db,
        user_id=test_user.id,
        device_id="electron-app",
        installed_id=installed.id,
        manual_retry=True,
    )
    sync.assert_awaited_once()
    assert (
        plugin_device_rows(test_db, test_user.id, "electron-app")[
            installed.id
        ].actual_release_id
        == 0
    )
