import asyncio
import threading
from contextlib import contextmanager
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device import plugin_reconciliation as module
from app.services.plugin_write_errors import PluginWriteError


@pytest.fixture
def reconciliation(monkeypatch):
    @contextmanager
    def session():
        yield Mock()

    monkeypatch.setattr(module, "get_db_session", session)
    record = Mock()
    monkeypatch.setattr(
        module.plugin_device_installation_service, "record_device_sync_result", record
    )
    dispatch = AsyncMock(
        return_value=DeviceCapabilitySyncResult(
            device_id="device", success=True, scope="plugins"
        )
    )
    monkeypatch.setattr(
        module.device_capability_sync_service, "sync_device_payload", dispatch
    )
    snapshot = {
        "scope": "plugins",
        "mode": "merge",
        "plugins": [{"installed_plugin_id": 12}],
    }
    desired = Mock(return_value=snapshot)
    monkeypatch.setattr(module, "desired_plugins", desired)
    return desired, dispatch, record


@pytest.mark.asyncio
async def test_reconciliation_rereads_desired_state_after_concurrent_uninstall(
    reconciliation,
):
    desired, dispatch, record = reconciliation
    installed = {
        "scope": "plugins",
        "mode": "merge",
        "plugins": [{"installed_plugin_id": 12}],
    }
    removed = {"scope": "plugins", "mode": "merge", "plugins": []}
    desired.side_effect = [installed, removed, removed]
    result = await module.reconcile_device_plugins(7, "device")
    assert result.reconciled
    assert dispatch.await_count == 2
    assert dispatch.call_args.kwargs["payload"]["plugins"] == []
    record.assert_called_once()


@pytest.mark.asyncio
async def test_reconciliation_does_not_acknowledge_older_executor(reconciliation):
    _, dispatch, record = reconciliation
    dispatch.return_value = DeviceCapabilitySyncResult(device_id="device", success=True)
    with pytest.raises(HTTPException) as exc:
        await module.reconcile_device_plugins(7, "device")
    assert exc.value.status_code == 409
    record.assert_not_called()


@pytest.mark.asyncio
async def test_failed_device_sync_is_not_success(reconciliation):
    _, dispatch, record = reconciliation
    dispatch.return_value = DeviceCapabilitySyncResult(
        device_id="device", success=False, error="device is offline"
    )
    with pytest.raises(HTTPException) as exc:
        await module.reconcile_device_plugins(7, "device")
    assert exc.value.status_code == 502
    assert exc.value.detail == "Plugin reconciliation failed: device is offline"
    record.assert_not_called()


@pytest.mark.asyncio
async def test_incomplete_snapshot_never_dispatches_an_empty_replacement(
    reconciliation,
):
    desired, dispatch, _ = reconciliation
    desired.side_effect = RuntimeError("database unavailable")
    with pytest.raises(RuntimeError):
        await module.reconcile_device_plugins(7, "device")
    dispatch.assert_not_awaited()


def test_snapshot_ignores_rotating_download_urls_but_not_installation_changes():
    a = {"plugins": [{"installed_plugin_id": 1, "release_id": 2, "download_path": "a"}]}
    b = {"plugins": [{"installed_plugin_id": 1, "release_id": 2, "download_path": "b"}]}
    assert module.plugin_snapshot(a) == module.plugin_snapshot(b)
    b["plugins"][0]["release_id"] = 3
    assert module.plugin_snapshot(a) != module.plugin_snapshot(b)


@pytest.mark.asyncio
async def test_partial_plugin_failure_is_not_acknowledged_as_reconciled(reconciliation):
    _, dispatch, record = reconciliation
    dispatch.return_value = DeviceCapabilitySyncResult(
        device_id="device",
        success=True,
        scope="plugins",
        plugins=[
            {
                "id": 12,
                "name": "example",
                "status": "failed",
                "stage": "download",
                "error_code": "PLUGIN_DOWNLOAD_FAILED",
                "error": "download failed",
            }
        ],
    )
    with pytest.raises(HTTPException) as exc:
        await module.reconcile_device_plugins(7, "device")
    assert exc.value.status_code == 502
    assert exc.value.detail == (
        "Plugin reconciliation failed for example: PLUGIN_DOWNLOAD_FAILED"
    )
    record.assert_not_called()


def test_failure_detail_preserves_executor_error_without_code_or_stage():
    result = DeviceCapabilitySyncResult(
        device_id="device",
        success=False,
        scope="plugins",
        plugins=[
            {
                "id": 12,
                "name": "example",
                "status": "failed",
                "error": "package checksum mismatch",
            }
        ],
    )

    assert module.reconciliation_failure_detail(result) == (
        "Plugin reconciliation failed for example: package checksum mismatch"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ("initial_snapshot", "latest_snapshot", "record"))
async def test_reconciliation_waits_leave_loop_responsive_and_sessions_in_worker(
    monkeypatch, stage
):
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    started = asyncio.Event()
    release = threading.Event()
    sessions = []
    snapshots = 0

    class TrackedSession:
        def __init__(self):
            self.threads = [threading.get_ident()]
            self.closed = False
            sessions.append(self)

        def touch(self):
            self.threads.append(threading.get_ident())

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

    def operation(db, current):
        db.touch()
        assert threading.get_ident() != loop_thread
        if current == stage:
            loop.call_soon_threadsafe(started.set)
            assert release.wait(5), "Test did not release the database operation"

    def snapshot(db, **kwargs):
        nonlocal snapshots
        snapshots += 1
        operation(db, "initial_snapshot" if snapshots == 1 else "latest_snapshot")
        return 0

    def record(db, **kwargs):
        operation(db, "record")

    async def dispatch(**kwargs):
        assert all(db.closed for db in sessions)
        return DeviceCapabilitySyncResult(
            device_id="device", success=True, scope="plugins"
        )

    monkeypatch.setattr(module, "get_db_session", session)
    monkeypatch.setattr(module, "configure_plugin_session", lambda db: db.touch())
    monkeypatch.setattr(
        module.plugin_marketplace_service,
        "reconcile_stale_installed_catalog_refs",
        snapshot,
    )
    monkeypatch.setattr(
        module.device_capability_sync_service,
        "build_desired_plugins",
        lambda db, **kwargs: {"scope": "plugins", "mode": "merge", "plugins": []},
    )
    monkeypatch.setattr(
        module.device_capability_sync_service, "sync_device_payload", dispatch
    )
    monkeypatch.setattr(
        module.plugin_device_installation_service, "record_device_sync_result", record
    )

    task = asyncio.create_task(module.reconcile_device_plugins(7, "device"))
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        assert not task.done()
        assert not release.is_set()
    finally:
        release.set()
        result = await asyncio.wait_for(task, timeout=5)

    assert result.reconciled
    assert len(sessions) == 3
    assert all(db.closed for db in sessions)
    assert all(
        len(set(db.threads)) == 1 and db.threads[0] != loop_thread for db in sessions
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ("snapshot", "record"))
async def test_reconciliation_propagates_coordination_rejection_without_retry(
    reconciliation, stage
):
    desired, dispatch, record = reconciliation
    target = desired if stage == "snapshot" else record
    target.side_effect = PluginWriteError("plugin_write_busy")

    with pytest.raises(PluginWriteError, match="plugin_write_busy"):
        await module.reconcile_device_plugins(7, "device")

    if stage == "snapshot":
        desired.assert_called_once()
        dispatch.assert_not_awaited()
        record.assert_not_called()
    else:
        assert desired.call_count == 2
        dispatch.assert_awaited_once()
        record.assert_called_once()
