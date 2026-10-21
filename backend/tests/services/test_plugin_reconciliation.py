import asyncio
import threading
from contextlib import contextmanager
from datetime import datetime
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services import plugin_write_operations
from app.services.device import plugin_reconciliation as module
from app.services.device import plugin_removal_sync
from app.services.plugin_installation_operations import uninstall_account_plugin
from app.services.plugin_package_storage import plugin_package_storage
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_operations import run_plugin_operation
from tests.services.test_plugin_marketplace_v2 import _device_install


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
    monkeypatch.setattr(module, "acquire_plugin_write_lock", Mock())
    monkeypatch.setattr(
        module.device_capability_sync_service,
        "build_desired_plugins",
        lambda db, **kwargs: desired(kwargs["user_id"], kwargs["device_id"]),
    )
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
@pytest.mark.parametrize(
    "stage", ("initial_snapshot", "acquire", "latest_snapshot", "record")
)
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
        return {"scope": "plugins", "mode": "merge", "plugins": []}

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
        lambda db, **kwargs: 0,
    )
    monkeypatch.setattr(
        module.device_capability_sync_service,
        "build_desired_plugins",
        snapshot,
    )
    monkeypatch.setattr(
        module, "acquire_plugin_write_lock", lambda db, _: operation(db, "acquire")
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
    assert len(sessions) == 2
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


@pytest.fixture
def installed_reconciliation(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
    plugin_write_sessions,
):
    installed, release = _device_install(test_db, test_user.id)
    test_db.add(
        Kind(
            user_id=test_user.id,
            kind="Device",
            namespace="default",
            name="desktop",
            json={"spec": {"deviceId": "desktop", "deviceType": "local"}},
            is_active=True,
        )
    )
    test_db.add(
        PluginDeviceInstallation(
            user_id=test_user.id,
            installed_kind_id=installed.id,
            device_id="desktop",
            desired_release_id=release.id,
            actual_release_id=release.id,
            state="installed",
        )
    )
    test_db.commit()
    sessions = plugin_write_operations.get_db_session
    monkeypatch.setattr(module, "get_db_session", sessions)
    monkeypatch.setattr(plugin_removal_sync, "get_db_session", sessions)
    monkeypatch.setattr(
        plugin_package_storage,
        "presign_download",
        lambda key: (f"https://objects.example/{key}", datetime.now()),
    )
    return test_user.id, installed.id, release.id, sessions


@pytest.mark.asyncio
@pytest.mark.parametrize("resend_outcome", ["success", "failed", "offline"])
async def test_uninstall_committed_before_ack_lease_replaces_stale_snapshot(
    installed_reconciliation, monkeypatch, resend_outcome
):
    user_id, installed_id, release_id, sessions = installed_reconciliation
    loop = asyncio.get_running_loop()
    ack_waiting = asyncio.Event()
    release_ack = threading.Event()
    sent = []
    materialized: set[int] = set()
    original_ack = module.record_reconciliation_result

    def acknowledge(*args, **kwargs):
        if len(sent) == 1:
            loop.call_soon_threadsafe(ack_waiting.set)
            assert release_ack.wait(5), "Uninstall did not release the ACK worker"
        return original_ack(*args, **kwargs)

    async def dispatch(**kwargs):
        payload = kwargs["payload"]
        sent.append(module.plugin_snapshot(payload))
        if len(sent) == 2 and resend_outcome != "success":
            return DeviceCapabilitySyncResult(
                device_id="desktop",
                success=False,
                acknowledged=resend_outcome != "offline",
                scope="plugins",
                error=(
                    "device is offline"
                    if resend_outcome == "offline"
                    else "removal failed"
                ),
            )
        materialized.clear()
        materialized.update(item["installed_plugin_id"] for item in payload["plugins"])
        return DeviceCapabilitySyncResult(
            device_id="desktop",
            success=True,
            acknowledged=True,
            scope="plugins",
            plugins=[{"id": identity, "status": "synced"} for identity in materialized],
        )

    monkeypatch.setattr(module, "record_reconciliation_result", acknowledge)
    monkeypatch.setattr(
        module.device_capability_sync_service, "sync_device_payload", dispatch
    )
    task = asyncio.create_task(module.reconcile_device_plugins(user_id, "desktop"))
    try:
        await asyncio.wait_for(ack_waiting.wait(), timeout=5)
        await run_plugin_operation(
            uninstall_account_plugin, user_id=user_id, installed_id=installed_id
        )
        assert plugin_removal_sync.pending_removal_devices(user_id, "desktop") == {
            "desktop"
        }
    finally:
        release_ack.set()

    result, failure = None, None
    try:
        result = await asyncio.wait_for(task, timeout=5)
    except HTTPException as exc:
        failure = exc
    with sessions() as db:
        assert db.get(Kind, installed_id).is_active is False
        rows = db.query(PluginDeviceInstallation).filter_by(user_id=user_id).all()
        if resend_outcome == "success":
            assert rows == []
        else:
            assert len(rows) == 1, "Old ACK erased unconfirmed durable removal"
            assert rows[0].installed_kind_id == installed_id
            assert rows[0].actual_release_id == release_id
            assert rows[0].state == "uninstalling"

    if resend_outcome == "success":
        assert failure is None
        assert result is not None and result.reconciled
    else:
        assert (
            failure is not None
        ), "An obsolete ACK incorrectly reported reconciliation"
        assert failure.status_code == 502
    assert len(sent) == 2, "The obsolete installation ACK must trigger a fresh dispatch"
    assert [item["installed_plugin_id"] for item in sent[0]] == [installed_id]
    assert sent[1] == []
    pending = plugin_removal_sync.pending_removal_devices(user_id, "desktop")
    assert pending == (set() if resend_outcome == "success" else {"desktop"})
    assert materialized == (set() if resend_outcome == "success" else {installed_id})


@pytest.mark.asyncio
async def test_final_snapshot_and_ack_share_one_owned_lease_until_commit(
    installed_reconciliation, monkeypatch
):
    user_id, installed_id, _, _ = installed_reconciliation
    payload = await asyncio.to_thread(module.desired_plugins, user_id, "desktop")
    observed = []
    original_build = module.device_capability_sync_service.build_desired_plugins
    original_record = (
        module.plugin_device_installation_service.record_device_sync_result
    )

    def observe_lease(operation, db):
        lease = db.info["plugin_write_leases"][user_id]
        assert lease.lock.owned(), "Final snapshot and ACK must retain the lease"
        observed.append((operation, db, lease, threading.get_ident()))

    def build(db, **kwargs):
        observe_lease("snapshot", db)
        event.listen(
            db,
            "before_commit",
            lambda current: observe_lease("commit", current),
            once=True,
        )
        return original_build(db, **kwargs)

    def record(db, **kwargs):
        observe_lease("record", db)
        original_record(db, **kwargs)
        assert user_id not in db.info.get("plugin_write_leases", {})

    monkeypatch.setattr(
        module.device_capability_sync_service, "build_desired_plugins", build
    )
    monkeypatch.setattr(
        module.plugin_device_installation_service, "record_device_sync_result", record
    )
    result = await asyncio.to_thread(
        module.record_reconciliation_result,
        user_id,
        "desktop",
        payload,
        DeviceCapabilitySyncResult(
            device_id="desktop",
            success=True,
            acknowledged=True,
            scope="plugins",
            plugins=[{"id": installed_id, "status": "synced"}],
        ),
    )

    assert result is None
    assert [operation for operation, *_ in observed] == ["snapshot", "record", "commit"]
    _, snapshot_db, snapshot_lease, snapshot_thread = observed[0]
    _, record_db, record_lease, record_thread = observed[1]
    _, commit_db, commit_lease, commit_thread = observed[2]
    assert snapshot_db is record_db is commit_db
    assert snapshot_lease is record_lease is commit_lease
    assert snapshot_thread == record_thread == commit_thread != threading.get_ident()
    assert not snapshot_lease.lock.owned()
