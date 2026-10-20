from unittest.mock import Mock

import pytest
from sqlalchemy.exc import OperationalError

from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import (
    DeviceCapabilitySyncResponse,
    DeviceCapabilitySyncResult,
)
from app.services import plugin_device_installation_service as module
from app.services.plugin_device_installation_service import (
    PluginDeviceInstallationService,
)
from tests.services.test_plugin_marketplace_v2 import _device_install


def mysql_error(code: int) -> OperationalError:
    return OperationalError(
        "SELECT ... FOR UPDATE", {}, Exception(code, "database error")
    )


def test_record_sync_response_retries_entire_mysql_deadlock_transaction(monkeypatch):
    service = PluginDeviceInstallationService()
    db = Mock()
    response = DeviceCapabilitySyncResponse(results=[])
    reconcile = Mock(side_effect=[mysql_error(1213), None])
    monkeypatch.setattr(module, "reconcile_plugin_device_rows", reconcile)
    monkeypatch.setattr(module.time, "sleep", Mock())

    service.record_sync_response(db, user_id=7, response=response)

    assert reconcile.call_count == 2
    db.rollback.assert_called_once_with()
    db.commit.assert_called_once_with()


def test_record_sync_response_does_not_retry_other_database_errors(monkeypatch):
    service = PluginDeviceInstallationService()
    db = Mock()
    response = DeviceCapabilitySyncResponse(results=[])
    monkeypatch.setattr(
        module,
        "reconcile_plugin_device_rows",
        Mock(side_effect=mysql_error(1205)),
    )

    with pytest.raises(OperationalError):
        service.record_sync_response(db, user_id=7, response=response)

    db.rollback.assert_called_once_with()
    db.commit.assert_not_called()


@pytest.mark.asyncio
async def test_device_enumeration_does_not_restore_uninstalled_plugin(
    test_db, test_user, monkeypatch
):
    installed, release = _device_install(test_db, test_user.id)

    async def devices(db, user_id):
        installed.is_active = False
        db.commit()
        return [{"device_id": "desktop"}]

    monkeypatch.setattr(module.device_service, "get_all_devices", devices)

    await PluginDeviceInstallationService().ensure_pending_for_all_devices(
        test_db,
        user_id=test_user.id,
        installed_kind_id=installed.id,
        desired_release_id=release.id,
    )

    assert test_db.query(PluginDeviceInstallation).count() == 0


@pytest.mark.asyncio
async def test_device_enumeration_does_not_overwrite_newer_desired_release(
    test_db, test_user, monkeypatch
):
    installed, release = _device_install(test_db, test_user.id)

    async def devices(db, user_id):
        installed.json = {"spec": {"releaseId": release.id + 1}}
        db.commit()
        return [{"device_id": "desktop"}]

    monkeypatch.setattr(module.device_service, "get_all_devices", devices)

    await PluginDeviceInstallationService().ensure_pending_for_all_devices(
        test_db,
        user_id=test_user.id,
        installed_kind_id=installed.id,
        desired_release_id=release.id,
    )

    assert test_db.query(PluginDeviceInstallation).count() == 0


def test_old_uninstall_ack_preserves_reinstalled_device_state(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    test_db.add(
        PluginDeviceInstallation(
            user_id=test_user.id,
            installed_kind_id=installed.id,
            device_id="desktop",
            desired_release_id=release.id,
            state="pending",
        )
    )
    test_db.commit()

    PluginDeviceInstallationService().record_uninstall_response(
        test_db,
        user_id=test_user.id,
        installed_kind_id=installed.id,
        response=DeviceCapabilitySyncResponse(
            results=[DeviceCapabilitySyncResult(device_id="desktop", success=True)]
        ),
    )

    assert test_db.query(PluginDeviceInstallation).one().state == "pending"
