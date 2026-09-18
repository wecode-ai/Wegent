from contextlib import contextmanager
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device import plugin_reconciliation as module


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
        device_id="device", success=False
    )
    with pytest.raises(HTTPException) as exc:
        await module.reconcile_device_plugins(7, "device")
    assert exc.value.status_code == 502
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
                "error": "download failed",
            }
        ],
    )
    with pytest.raises(HTTPException) as exc:
        await module.reconcile_device_plugins(7, "device")
    assert exc.value.status_code == 502
    record.assert_not_called()
