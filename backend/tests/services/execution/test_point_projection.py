# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import orjson
import pytest

from app.services.execution import point_projection
from app.services.execution.point_projection import (
    ExecutionProjectionService,
    PointProjectionError,
)
from shared.models.responses_api import ResponsesAPIStreamEvents


class _RecordingStatusEmitter:
    instances: list["_RecordingStatusEmitter"] = []
    first_started: asyncio.Event | None = None
    release_first: asyncio.Event | None = None

    def __init__(self, **kwargs) -> None:
        self.events = []
        self.closed = 0
        self.instances.append(self)

    async def emit(self, event) -> None:
        self.events.append(event)
        if event.message_id == 1 and self.first_started and self.release_first:
            self.first_started.set()
            await self.release_first.wait()

    async def close(self) -> None:
        self.closed += 1


@pytest.fixture(autouse=True)
def _projection_side_effects(monkeypatch: pytest.MonkeyPatch):
    _RecordingStatusEmitter.instances = []
    _RecordingStatusEmitter.first_started = None
    _RecordingStatusEmitter.release_first = None
    monkeypatch.setattr(
        point_projection,
        "StatusUpdatingEmitter",
        _RecordingStatusEmitter,
    )
    monkeypatch.setattr(
        point_projection.channel_worker_client,
        "forward_event",
        AsyncMock(),
    )
    monkeypatch.setattr(
        point_projection.channel_worker_client,
        "runtime_local_event",
        AsyncMock(),
    )
    monkeypatch.setattr(
        point_projection.session_manager,
        "publish_callback_event",
        AsyncMock(return_value=True),
    )


def _body(
    event_type: str,
    *,
    task_id: int = 1,
    subtask_id: int = 2,
    message_id: int | None = None,
    data: dict | None = None,
) -> bytes:
    return orjson.dumps(
        {
            "event_type": event_type,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "message_id": message_id,
            "data": data or {},
        }
    )


@pytest.mark.asyncio
async def test_session_preserves_parser_state_until_terminal() -> None:
    service = ExecutionProjectionService()

    await service.project_callback_body(
        _body(
            ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            data={
                "item": {
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "search",
                }
            },
        ),
        batch=False,
    )
    await service.project_callback_body(
        _body(
            ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
            data={"call_id": "call-1", "delta": "{"},
        ),
        batch=False,
    )
    emitter = _RecordingStatusEmitter.instances[0]
    assert emitter.events[-1].tool_name == "search"
    assert emitter.closed == 0

    await service.project_callback_body(
        _body(
            ResponsesAPIStreamEvents.ERROR.value,
            data={"message": "failed"},
        ),
        batch=False,
    )

    assert emitter.closed == 1
    assert service._sessions == {}


@pytest.mark.asyncio
async def test_same_key_events_run_in_fifo_order() -> None:
    service = ExecutionProjectionService()
    _RecordingStatusEmitter.first_started = asyncio.Event()
    _RecordingStatusEmitter.release_first = asyncio.Event()

    first = asyncio.create_task(
        service.project_callback_body(
            _body(
                ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
                message_id=1,
                data={"delta": "first"},
            ),
            batch=False,
        )
    )
    await _RecordingStatusEmitter.first_started.wait()
    second = asyncio.create_task(
        service.project_callback_body(
            _body(
                ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
                message_id=2,
                data={"delta": "second"},
            ),
            batch=False,
        )
    )
    await asyncio.sleep(0)
    assert [
        event.message_id for event in _RecordingStatusEmitter.instances[0].events
    ] == [1]

    _RecordingStatusEmitter.release_first.set()
    await asyncio.gather(first, second)

    assert [
        event.message_id for event in _RecordingStatusEmitter.instances[0].events
    ] == [1, 2]


@pytest.mark.asyncio
async def test_session_capacity_rejects_without_evicting_live_state() -> None:
    service = ExecutionProjectionService(max_sessions=1)
    await service.project_callback_body(
        _body(ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value),
        batch=False,
    )

    with pytest.raises(PointProjectionError) as error:
        await service.project_callback_body(
            _body(
                ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
                task_id=3,
                subtask_id=4,
            ),
            batch=False,
        )

    assert error.value.error_code == "point_projection_session_overloaded"
    assert len(service._sessions) == 1


@pytest.mark.asyncio
async def test_idle_session_is_closed_before_reuse_of_capacity() -> None:
    service = ExecutionProjectionService(max_sessions=1, idle_ttl_seconds=0.01)
    await service.project_callback_body(
        _body(ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value),
        batch=False,
    )
    first = _RecordingStatusEmitter.instances[0]
    await asyncio.sleep(0.02)

    await service.project_callback_body(
        _body(
            ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
            task_id=3,
            subtask_id=4,
        ),
        batch=False,
    )

    assert first.closed == 1
    assert len(service._sessions) == 1


@pytest.mark.asyncio
async def test_invalid_raw_callback_is_structured_validation_error() -> None:
    service = ExecutionProjectionService()

    with pytest.raises(PointProjectionError) as error:
        await service.project_callback_body(b"{}", batch=False)

    assert error.value.error_code == "point_projection_validation"
    assert error.value.details


@pytest.mark.asyncio
async def test_runtime_events_for_same_device_remain_fifo(monkeypatch) -> None:
    service = ExecutionProjectionService()
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    projected: list[str] = []

    async def fake_run(function, device_id, payload, user_id):
        del function, device_id, user_id
        event = str(payload["event"])
        projected.append(event)
        if event == "first":
            first_started.set()
            await release_first.wait()
        return None

    sio = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr(point_projection, "run_sync_in_executor", fake_run)
    monkeypatch.setattr(point_projection, "get_sio", lambda: sio)

    first = asyncio.create_task(
        service.project_runtime_event(
            user_id=7,
            device_id="physical-device",
            logical_device_id="logical-device",
            data={"event": "first", "payload": {}},
        )
    )
    await first_started.wait()
    second = asyncio.create_task(
        service.project_runtime_event(
            user_id=7,
            device_id="physical-device",
            logical_device_id="logical-device",
            data={"event": "second", "payload": {}},
        )
    )
    await asyncio.sleep(0)
    assert projected == ["first"]

    release_first.set()
    await asyncio.gather(first, second)

    assert projected == ["first", "second"]
    assert [
        call.args[1]["payload"]["deviceId"] for call in sio.emit.await_args_list
    ] == [
        "logical-device",
        "logical-device",
    ]


@pytest.mark.asyncio
async def test_runtime_task_update_projects_and_notifies_in_worker(monkeypatch) -> None:
    service = ExecutionProjectionService()
    projected_payloads: list[dict] = []

    async def fake_run(function, device_id, payload, user_id, trusted):
        del function
        assert (device_id, user_id, trusted) == ("device-1", 7, True)
        projected_payloads.append(payload)
        return {
            "message": {"projectId": "project-1", "taskId": "task-1"},
            "mode": "created",
            "workflow_continuation": None,
        }

    sio = SimpleNamespace(emit=AsyncMock())
    notify = AsyncMock(return_value={"sent": 1, "results": []})
    monkeypatch.setattr(point_projection, "run_sync_in_executor", fake_run)
    monkeypatch.setattr(point_projection, "get_sio", lambda: sio)
    monkeypatch.setattr(
        point_projection.im_notification_dispatcher,
        "send_runtime_task_update_for_user",
        notify,
    )
    monkeypatch.setattr(
        point_projection,
        "continue_projected_workflow",
        AsyncMock(),
    )

    result = await service.project_runtime_task_updated(
        user_id=7,
        device_id="device-1",
        data={
            "localTaskId": "codex-thread-1",
            "workspacePath": "/repo",
            "title": "Native task",
            "status": "done",
            "content": "Implemented",
        },
    )

    assert result == {"success": True, "notified": 1}
    assert projected_payloads[0]["event"] == "runtime.task.completed"
    notify.assert_awaited_once_with(
        user_id=7,
        address={
            "deviceId": "device-1",
            "localTaskId": "codex-thread-1",
            "workspacePath": "/repo",
        },
        title="Native task",
        status="done",
        content="Implemented",
        source="codex_watcher",
    )
    sio.emit.assert_awaited_once()


@pytest.mark.asyncio
async def test_runtime_task_update_skips_nonterminal_without_side_effects(
    monkeypatch,
) -> None:
    service = ExecutionProjectionService()
    run = AsyncMock()
    notify = AsyncMock()
    monkeypatch.setattr(point_projection, "run_sync_in_executor", run)
    monkeypatch.setattr(
        point_projection.im_notification_dispatcher,
        "send_runtime_task_update_for_user",
        notify,
    )

    result = await service.project_runtime_task_updated(
        user_id=7,
        device_id="device-1",
        data={"localTaskId": "codex-thread-1", "status": "streaming"},
    )

    assert result == {
        "success": True,
        "notified": 0,
        "skipped": "non_terminal",
    }
    run.assert_not_awaited()
    notify.assert_not_awaited()
