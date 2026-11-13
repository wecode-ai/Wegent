"""App task events obey live local consent without changing project grants."""

from unittest.mock import AsyncMock

import pytest

from app.api.ws import device_namespace


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [None, False, "true", True])
@pytest.mark.parametrize("project", [False, True])
async def test_app_stream_revocation_and_record_scoped_identity(
    monkeypatch, enabled, project
):
    namespace = device_namespace.DeviceNamespace()
    sio = AsyncMock()
    publish = AsyncMock()
    projection = (
        {"mode": "snapshot", "message": {"projectId": "project-1"}} if project else None
    )
    persist = AsyncMock(return_value=projection)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(
            return_value={
                "user_id": 7,
                "device_id": "app-record-22",
                "logical_device_id": "same-name",
                "device_type": "app",
            }
        ),
    )
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio)
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", persist)
    monkeypatch.setattr("app.services.wework_api.events.publish_runtime_event", publish)
    monkeypatch.setattr(namespace, "_notify_runtime_event", AsyncMock())
    monkeypatch.setattr(
        namespace._local_task_responses,
        "forward_runtime_event_to_channels",
        AsyncMock(),
    )
    data = {
        "event": "response.output_text.delta",
        "payload": {
            "taskId": "task-1",
            "deviceId": "same-name",
            "data": {"delta": "private"},
        },
    }
    if enabled is not None:
        data["appRemoteTaskAccessEnabled"] = enabled
    assert await namespace.on_runtime_event("sid", data) == {"success": True}
    # Durable project projection is independent of personal device consent.
    persist.assert_awaited_once()
    raw_events = [
        call for call in sio.emit.await_args_list if call.args[0] == "runtime:event"
    ]
    assert len(raw_events) == int(enabled is True or project)
    assert publish.await_count == int(enabled is True)
    if raw_events:
        payload = raw_events[0].args[1]
        assert payload["payload"]["deviceId"] == "app-record-22"
        assert payload["payload"]["device_id"] == "app-record-22"
        assert "appRemoteTaskAccessEnabled" not in payload
    assert sum(
        call.args[0] == "wework:project_chat:message:created"
        for call in sio.emit.await_args_list
    ) == int(project)
