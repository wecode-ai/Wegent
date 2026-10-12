import asyncio
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, Mock

import pytest

from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device import plugin_removal_sync as module


@pytest.fixture
def sync_context(monkeypatch):
    @contextmanager
    def session():
        yield Mock()

    monkeypatch.setattr(module, "get_db_session", session)
    monkeypatch.setattr(module, "pending_removal_devices", lambda *_: {"device"})
    record = Mock()
    dispatch = AsyncMock(
        return_value=DeviceCapabilitySyncResult(device_id="device", success=True)
    )
    monkeypatch.setattr(
        module.device_capability_sync_service,
        "sync_current_device_capabilities",
        dispatch,
    )
    monkeypatch.setattr(
        module.plugin_device_installation_service, "record_device_sync_result", record
    )
    return dispatch, record


@pytest.mark.asyncio
async def test_heartbeat_does_not_duplicate_inflight_cleanup(sync_context):
    dispatch, record = sync_context
    started, release = asyncio.Event(), asyncio.Event()

    async def wait_for_device(**kwargs):
        started.set()
        await release.wait()
        return DeviceCapabilitySyncResult(device_id="device", success=True)

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
