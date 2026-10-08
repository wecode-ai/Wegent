import asyncio
from contextlib import contextmanager
from unittest.mock import AsyncMock, Mock

import pytest

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
