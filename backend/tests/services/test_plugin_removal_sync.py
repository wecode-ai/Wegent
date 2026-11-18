import asyncio
import logging
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device import plugin_removal_sync as module
from app.services.device.plugin_sync_io import await_plugin_sync_device


@pytest.fixture
def sync_context(monkeypatch):
    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=SimpleNamespace(online_info={})),
    )
    monkeypatch.setattr(module, "_pending_removals", lambda *_: {1: 4})
    monkeypatch.setattr(module, "_legacy_receipt_revisions", lambda *_: {})

    @contextmanager
    def session():
        yield Mock()

    monkeypatch.setattr(module, "get_db_session", session)
    record = Mock()
    monkeypatch.setattr(
        module,
        "pending_removal_devices",
        lambda *_: set() if record.call_count else {"device"},
    )
    dispatch = AsyncMock(
        return_value=DeviceCapabilitySyncResult(
            device_id="device", success=True, acknowledged=True
        )
    )
    monkeypatch.setattr(
        module.device_capability_sync_service,
        "sync_current_device_capabilities",
        dispatch,
    )
    monkeypatch.setattr(
        module.plugin_device_installation_service, "record_scoped_device_result", record
    )
    return dispatch, record


@pytest.mark.asyncio
async def test_heartbeat_does_not_duplicate_inflight_cleanup(sync_context, caplog):
    caplog.set_level(logging.INFO, logger=module.__name__)
    dispatch, record = sync_context
    started, release = asyncio.Event(), asyncio.Event()

    async def wait_for_device(**kwargs):
        started.set()
        await release.wait()
        return DeviceCapabilitySyncResult(
            device_id="device", success=True, acknowledged=True
        )

    dispatch.side_effect = wait_for_device
    first = asyncio.create_task(module.sync_pending_plugin_removals(1))
    await started.wait()
    try:
        await module.sync_pending_plugin_removals(1, "device")
        dispatch.assert_awaited_once()
    finally:
        release.set()
        await first
    record.assert_called_once()
    assert not module._inflight
    assert "reason=inflight user_id=1 device_id=device" in caplog.text
    assert "Plugin removal result recorded user_id=1 device_id=device" in caplog.text


@pytest.mark.asyncio
async def test_failed_background_task_can_be_recovered_on_next_heartbeat(sync_context):
    dispatch, record = sync_context
    dispatch.side_effect = RuntimeError("transport unavailable")
    await module.sync_pending_plugin_removals(1)
    record.assert_not_called()
    assert not module._inflight

    dispatch.side_effect = None
    await module.sync_pending_plugin_removals(1, "device")
    assert dispatch.await_count == 2
    record.assert_called_once()


@pytest.mark.asyncio
async def test_cleanup_database_reads_and_writes_run_off_the_event_loop(
    sync_context, monkeypatch
):
    _, record = sync_context
    loop_thread = threading.get_ident()
    query_threads, write_threads = [], []

    def pending(*_):
        query_threads.append(threading.get_ident())
        return {"device"}

    record.side_effect = lambda *args, **kwargs: write_threads.append(
        threading.get_ident()
    )
    monkeypatch.setattr(module, "pending_removal_devices", pending)

    await module.sync_pending_plugin_removals(1)

    assert len(query_threads) == len(write_threads) == 1
    assert query_threads[0] != loop_thread
    assert write_threads[0] != loop_thread


@pytest.mark.asyncio
@pytest.mark.parametrize("route_unavailable", [True, False])
async def test_unconfirmed_removal_does_not_write_device_state(
    sync_context, monkeypatch, route_unavailable
):
    dispatch, record = sync_context
    if route_unavailable:
        module.runtime_route_resolver.resolve.side_effect = module.RuntimeRouteError(
            "device_offline", "Fixture device is offline"
        )
    dispatch.return_value = DeviceCapabilitySyncResult(
        device_id="device", success=False
    )

    await module.sync_pending_plugin_removals(1)

    assert dispatch.await_count == int(not route_unavailable)
    record.assert_not_called()


@pytest.mark.asyncio
async def test_healthy_device_records_removal_while_other_accounts_wait_for_rpc(
    sync_context, monkeypatch
):
    dispatch, record = sync_context
    monkeypatch.setattr(module, "_removal_db_slots", asyncio.Semaphore(2))
    monkeypatch.setattr(module, "pending_removal_devices", lambda _, device: {device})
    monkeypatch.setattr(module, "_pending_removals", lambda *_: {3: 4, 1: 4})
    started = asyncio.Event()
    release = asyncio.Event()

    waiting = set()

    async def rpc(device_id):
        if device_id in {"a", "b"}:
            waiting.add(device_id)
            if len(waiting) == 2:
                started.set()
            await release.wait()
        return DeviceCapabilitySyncResult(
            device_id=device_id, success=True, acknowledged=True
        )

    async def deliver(**kwargs):
        return await await_plugin_sync_device(rpc, kwargs["device_id"])

    dispatch.side_effect = deliver
    tasks = [
        asyncio.create_task(module.sync_pending_plugin_removals(i, device))
        for i, device in [(1, "a"), (2, "b")]
    ]
    try:
        await asyncio.wait_for(started.wait(), timeout=3)
        await asyncio.wait_for(module.sync_pending_plugin_removals(3, "c"), timeout=3)
        assert [
            (call.kwargs["result"].device_id, call.kwargs["installed_id"])
            for call in record.call_args_list
        ] == [("c", 1), ("c", 3)]
    finally:
        release.set()
        await asyncio.gather(*tasks)
    assert dispatch.await_count == 3
    assert (
        sorted(call.kwargs["installed_id"] for call in record.call_args_list)
        == [1] * 3 + [3] * 3
    )


@pytest.mark.asyncio
async def test_busy_removal_retries_the_receipt_without_redispatch(
    sync_context, monkeypatch
):
    dispatch, record = sync_context
    monkeypatch.setattr(module, "_pending_removals", lambda *_: {1: 4, 3: 6})
    record.side_effect = [
        module.PluginWriteError("plugin_write_busy"),
        None,
        module.PluginWriteError("plugin_write_conflict"),
        None,
    ]

    await module.sync_pending_plugin_removals(1)

    dispatch.assert_awaited_once()
    assert [
        (call.kwargs["installed_id"], call.kwargs["revision"])
        for call in record.call_args_list
    ] == [(1, 4), (3, 6), (1, 4), (1, 4)]


@pytest.mark.asyncio
async def test_busy_receipts_leave_database_capacity_for_other_accounts(
    sync_context, monkeypatch
):
    dispatch, record = sync_context
    monkeypatch.setattr(module, "_removal_db_slots", asyncio.Semaphore(2))
    monkeypatch.setattr(module, "pending_removal_devices", lambda _, device: {device})
    loop = asyncio.get_running_loop()
    started = {user_id: asyncio.Event() for user_id in (1, 2)}
    release = threading.Event()

    def write(_db, **kwargs):
        user_id = kwargs["user_id"]
        if user_id in started and not release.is_set():
            loop.call_soon_threadsafe(started[user_id].set)
            raise module.PluginWriteError("plugin_write_busy")

    record.side_effect = write
    tasks = [
        asyncio.create_task(module.sync_pending_plugin_removals(user_id, device))
        for user_id, device in [(1, "a"), (2, "b")]
    ]
    try:
        await asyncio.wait_for(
            asyncio.gather(*(event.wait() for event in started.values())), 2
        )
        await asyncio.wait_for(module.sync_pending_plugin_removals(3, "c"), 2)
        assert any(call.kwargs["user_id"] == 3 for call in record.call_args_list)
        assert not any(task.done() for task in tasks)
    finally:
        release.set()
        await asyncio.gather(*tasks)
    assert dispatch.await_count == 3


@pytest.mark.asyncio
async def test_three_devices_keep_acknowledged_removals_after_the_same_lease(
    sync_context, monkeypatch
):
    dispatch, record = sync_context
    monkeypatch.setattr(module, "_removal_db_slots", asyncio.Semaphore(2))
    monkeypatch.setattr(module, "pending_removal_devices", lambda *_: {"a", "b", "c"})
    loop = asyncio.get_running_loop()
    owner_started = asyncio.Event()
    contended = {device: asyncio.Event() for device in ("b", "c")}
    release = threading.Event()
    persisted = set()

    async def deliver(*, device_id, **_):
        if device_id != "a":
            await owner_started.wait()
        return DeviceCapabilitySyncResult(
            device_id=device_id, success=True, acknowledged=True
        )

    def write(_db, *, result, **_):
        if result.device_id == "a":
            loop.call_soon_threadsafe(owner_started.set)
            assert release.wait(5)
        elif not release.is_set():
            loop.call_soon_threadsafe(contended[result.device_id].set)
            raise module.PluginWriteError("plugin_write_busy")
        persisted.add(result.device_id)

    dispatch.side_effect = deliver
    record.side_effect = write
    removal = asyncio.create_task(module.sync_pending_plugin_removals(1))
    try:
        await asyncio.wait_for(
            asyncio.gather(*(event.wait() for event in contended.values())), 2
        )
    finally:
        release.set()
        await removal
    assert persisted == {"a", "b", "c"}
    assert dispatch.await_count == 3


@pytest.mark.parametrize(
    "attempts,delay", [(1, 60), (2, 120), (3, 240), (8, 3600), (1000, 3600)]
)
def test_failed_removal_uses_bounded_backoff(attempts, delay):
    now = datetime.now()
    row = PluginDeviceInstallation(state="failed", attempt_count=attempts)
    row.last_sync_at = now - timedelta(seconds=delay - 1)
    assert not module.removal_retry_due(row, now)
    row.last_sync_at = now - timedelta(seconds=delay)
    assert module.removal_retry_due(row, now)


def test_new_uninstall_remains_immediate_and_missing_attempt_time_is_not_due():
    row = PluginDeviceInstallation(state="uninstalling", attempt_count=10)
    assert module.removal_retry_due(row, datetime.now())
    row.state = "failed"
    assert not module.removal_retry_due(row, datetime.now())
