from unittest.mock import Mock

import pytest
from sqlalchemy.exc import OperationalError

from app.schemas.device import DeviceCapabilitySyncResponse
from app.services import plugin_device_installation_service as module
from app.services.plugin_device_installation_service import (
    PluginDeviceInstallationService,
)


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
