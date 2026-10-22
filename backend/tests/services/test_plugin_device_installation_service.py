import asyncio
import threading
from contextlib import contextmanager
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy.exc import OperationalError

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import (
    DeviceCapabilitySyncResponse,
    DeviceCapabilitySyncResult,
)
from app.schemas.installed_plugin import InstalledPlugin
from app.services import plugin_device_installation_service as module
from app.services import plugin_device_sync, plugin_write_operations
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
    test_db, test_user, monkeypatch, plugin_write_sessions
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
    test_db, test_user, monkeypatch, plugin_write_sessions
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


@pytest.mark.parametrize("success", [True, False])
@pytest.mark.parametrize("string_id", [True, False])
def test_old_install_ack_preserves_new_uninstall_queue(
    test_db, test_user, success, string_id
):
    installed, release = _device_install(test_db, test_user.id)
    installed.is_active = False
    row = PluginDeviceInstallation(
        user_id=test_user.id,
        installed_kind_id=installed.id,
        device_id="desktop",
        desired_release_id=release.id,
        actual_release_id=release.id,
        state="uninstalling",
        attempt_count=2,
        error_code="PRESERVE_REMOVAL",
        error_message="Removal is waiting for its own acknowledgement",
    )
    test_db.add(row)
    test_db.commit()
    previous = (row.state, row.attempt_count, row.error_code, row.error_message)

    PluginDeviceInstallationService().record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="desktop",
            success=success,
            plugins=[
                {
                    "id": str(installed.id) if string_id else installed.id,
                    "status": "synced" if success else "failed",
                    "error": None if success else "Old install failed",
                }
            ],
        ),
    )

    test_db.expire_all()
    preserved = test_db.query(PluginDeviceInstallation).one()
    assert (
        preserved.state,
        preserved.attempt_count,
        preserved.error_code,
        preserved.error_message,
    ) == previous
    assert test_db.get(Kind, installed.id).is_active is False


def test_complete_removal_ack_clears_uninstall_queue(test_db, test_user):
    installed, release = _device_install(test_db, test_user.id)
    installed.is_active = False
    test_db.add(
        PluginDeviceInstallation(
            user_id=test_user.id,
            installed_kind_id=installed.id,
            device_id="desktop",
            desired_release_id=release.id,
            actual_release_id=release.id,
            state="uninstalling",
        )
    )
    test_db.commit()

    PluginDeviceInstallationService().record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="desktop", success=True, scope="plugins", plugins=[]
        ),
    )

    assert test_db.query(PluginDeviceInstallation).count() == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("current_device_only", [True, False])
async def test_single_plugin_ack_preserves_unrelated_removal_queue(
    test_db, test_user, monkeypatch, plugin_write_sessions, current_device_only
):
    installed, release = _device_install(test_db, test_user.id)
    unrelated = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="pending-removal",
        is_active=False,
        json={"spec": {"releaseId": release.id}},
    )
    test_db.add(unrelated)
    test_db.flush()
    unrelated_id = unrelated.id
    installed_id = installed.id
    release_id = release.id
    test_db.add(
        PluginDeviceInstallation(
            user_id=test_user.id,
            installed_kind_id=unrelated_id,
            device_id="desktop",
            desired_release_id=release_id,
            actual_release_id=release_id,
            state="uninstalling",
        )
    )
    test_db.commit()
    response = DeviceCapabilitySyncResponse(
        mode="merge",
        results=[
            DeviceCapabilitySyncResult(
                device_id="desktop",
                success=True,
                plugins=[{"id": installed_id, "status": "synced"}],
            )
        ],
    )
    dispatch = AsyncMock(return_value=response)
    monkeypatch.setattr(
        plugin_device_sync.device_capability_sync_service,
        "sync_installed_plugin_to_device",
        dispatch,
    )

    if current_device_only:
        result = await plugin_device_sync.sync_plugin_after_change(
            test_db,
            user_id=test_user.id,
            installed=InstalledPlugin(
                metadata={"labels": {"id": str(installed_id)}},
                spec={
                    "source": {"pluginKey": installed.name},
                    "displayName": installed.name,
                    "releaseId": release_id,
                },
            ),
            device_id="desktop",
            sync_current_device_only=True,
        )
    else:
        result = await plugin_device_sync.ensure_installed_plugin_on_device(
            test_db,
            user_id=test_user.id,
            device_id="desktop",
            installed_id=installed_id,
        )

    assert result.success
    dispatch.assert_awaited_once()
    test_db.expire_all()
    rows = {
        row.installed_kind_id: row
        for row in test_db.query(PluginDeviceInstallation).all()
    }
    assert rows[unrelated_id].state == "uninstalling"
    assert rows[installed_id].state == "installed"
    assert rows[installed_id].actual_release_id == release_id


@pytest.mark.asyncio
async def test_all_device_materialization_waits_in_its_own_worker_session(monkeypatch):
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    started = asyncio.Event()
    release = threading.Event()
    sessions = []
    request_db = Mock()

    class TrackedSession:
        def __init__(self):
            self.threads = [threading.get_ident()]
            self.closed = False
            sessions.append(self)

        def touch(self):
            self.threads.append(threading.get_ident())

        def query(self, *args):
            self.touch()
            return self

        def filter_by(self, **kwargs):
            self.touch()
            return self

        def populate_existing(self):
            self.touch()
            return self

        def first(self):
            self.touch()
            return None

        def commit(self):
            self.touch()

        def close(self):
            self.touch()
            self.closed = True

    @contextmanager
    def session():
        db = TrackedSession()
        try:
            yield db
        finally:
            db.close()

    async def devices(db, user_id):
        assert db is request_db
        assert threading.get_ident() == loop_thread
        assert sessions == []
        return [{"device_id": "desktop"}]

    def acquire(db, user_id):
        db.touch()
        assert db is not request_db
        assert threading.get_ident() != loop_thread
        request_db.close.assert_called_once_with()
        loop.call_soon_threadsafe(started.set)
        assert release.wait(5), "Test did not release the database operation"

    monkeypatch.setattr(module.device_service, "get_all_devices", devices)
    monkeypatch.setattr(module, "acquire_plugin_write_lock", acquire)
    monkeypatch.setattr(plugin_write_operations, "get_db_session", session)
    monkeypatch.setattr(
        plugin_write_operations, "configure_plugin_session", lambda db: db.touch()
    )

    task = asyncio.create_task(
        PluginDeviceInstallationService().ensure_pending_for_all_devices(
            request_db,
            user_id=7,
            installed_kind_id=11,
            desired_release_id=13,
        )
    )
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        assert not task.done()
        assert not release.is_set()
    finally:
        release.set()
        await asyncio.wait_for(task, timeout=5)

    request_db.close.assert_called_once_with()
    assert len(sessions) == 1
    assert sessions[0].closed
    assert len(set(sessions[0].threads)) == 1
    assert sessions[0].threads[0] != loop_thread
