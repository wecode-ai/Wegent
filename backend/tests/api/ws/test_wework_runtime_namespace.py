# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Wework runtime IPC relay namespace."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.ws import device_namespace, wework_runtime_namespace
from app.api.ws.device_namespace import DeviceNamespace
from app.api.ws.wework_runtime_namespace import WeworkRuntimeNamespace


@pytest.mark.asyncio
async def test_device_runtime_event_persists_project_chat_before_browser_relay(
    monkeypatch,
):
    namespace = DeviceNamespace()
    calls: list[str] = []
    sio = AsyncMock()

    async def project_event(*args, **kwargs):
        calls.append("persist")
        return {
            "mode": "snapshot",
            "message": {
                "projectId": "project-1",
                "taskId": "task-1",
            },
        }

    async def emit(*args, **kwargs):
        calls.append("emit")

    sio.emit.side_effect = emit
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", project_event)
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio)

    result = await namespace.on_runtime_event(
        "device-sid",
        {
            "event": "response.completed",
            "payload": {
                "taskId": "runtime-task-1",
                "data": {"value": "done"},
            },
        },
    )

    assert result == {"success": True}
    assert calls == ["persist", "emit", "emit"]
    assert sio.emit.await_args_list[0].args[0] == (
        "wework:project_chat:message:created"
    )
    assert sio.emit.await_args_list[1].args[0] == "runtime:event"


@pytest.mark.asyncio
async def test_device_runtime_events_preserve_socket_order(monkeypatch):
    namespace = DeviceNamespace()
    calls: list[str] = []
    first_persist_started = asyncio.Event()
    release_first_persist = asyncio.Event()
    sio = AsyncMock()

    async def project_event(_func, _device_id, payload):
        event_name = payload["event"]
        calls.append(f"persist:{event_name}")
        if event_name == "response.block.created":
            first_persist_started.set()
            await release_first_persist.wait()
        return None

    async def emit(_event_name, payload, **_kwargs):
        calls.append(f"emit:{payload['event']}")

    sio.emit.side_effect = emit
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", project_event)
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio)

    created = asyncio.create_task(
        namespace.on_runtime_event(
            "device-sid",
            {"event": "response.block.created", "payload": {}},
        )
    )
    await first_persist_started.wait()
    updated = asyncio.create_task(
        namespace.on_runtime_event(
            "device-sid",
            {"event": "response.block.updated", "payload": {}},
        )
    )
    await asyncio.sleep(0)

    assert calls == ["persist:response.block.created"]

    release_first_persist.set()
    assert await created == {"success": True}
    assert await updated == {"success": True}
    assert calls == [
        "persist:response.block.created",
        "emit:response.block.created",
        "persist:response.block.updated",
        "emit:response.block.updated",
    ]


@pytest.mark.asyncio
async def test_runtime_request_relays_to_device_runtime_rpc(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    runtime_rpc = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(
        wework_runtime_namespace.runtime_rpc_service,
        "call",
        runtime_rpc,
    )
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7}),
    )

    response = await namespace.on_runtime_request(
        "browser-sid",
        {
            "id": "req-1",
            "device_id": "cloud-device",
            "method": "runtime.tasks.create",
            "params": {"message": "hello"},
        },
    )

    assert response == {"id": "req-1", "ok": True, "result": {"accepted": True}}
    runtime_rpc.assert_awaited_once_with(
        user_id=7,
        device_id="cloud-device",
        method="runtime.tasks.create",
        payload={"message": "hello"},
        timeout_seconds=75,
    )


@pytest.mark.asyncio
async def test_runtime_request_rejects_executor_failure_envelope(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    monkeypatch.setattr(
        wework_runtime_namespace.runtime_rpc_service,
        "call",
        AsyncMock(
            return_value={
                "success": False,
                "error": {"message": "Codex app server restart failed"},
            }
        ),
    )
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7}),
    )

    response = await namespace.on_runtime_request(
        "browser-sid",
        {
            "id": "req-1",
            "device_id": "cloud-device",
            "method": "runtime.codex.app_server.restart",
            "params": {"ifIdle": True},
        },
    )

    assert response == {
        "id": "req-1",
        "ok": False,
        "error": {
            "code": "runtime_rpc_failed",
            "message": "Codex app server restart failed",
        },
    }


@pytest.mark.asyncio
async def test_runtime_request_requires_device_id(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7}),
    )

    response = await namespace.on_runtime_request(
        "browser-sid",
        {
            "id": "req-1",
            "method": "runtime.tasks.list",
            "params": {},
        },
    )

    assert response == {
        "id": "req-1",
        "ok": False,
        "error": {"code": "bad_request", "message": "device_id is required"},
    }


@pytest.mark.asyncio
async def test_project_chat_subscribe_joins_project_room_and_returns_history(
    monkeypatch,
):
    namespace = WeworkRuntimeNamespace()
    history = [{"sequenceNumber": 4, "messageId": "message-4"}]
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "user_name": "Ada"}),
    )
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())
    monkeypatch.setattr(
        wework_runtime_namespace,
        "run_sync_in_executor",
        AsyncMock(return_value=history),
    )

    response = await namespace.on_project_chat_subscribe(
        "browser-sid", {"projectId": "project-1", "afterSequence": 2}
    )

    assert response == {
        "ok": True,
        "result": {
            "messages": history,
            "currentUserId": "7",
            "latestSequence": 4,
        },
    }
    namespace.enter_room.assert_awaited_once_with(
        "browser-sid", "wework-project-chat:project:project-1"
    )


@pytest.mark.asyncio
async def test_project_chat_send_broadcasts_only_its_task_room(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    message = {"sequenceNumber": 5, "messageId": "message-5"}
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "user_name": "Ada"}),
    )
    monkeypatch.setattr(namespace, "emit", AsyncMock())
    monkeypatch.setattr(
        wework_runtime_namespace,
        "run_sync_in_executor",
        AsyncMock(return_value={"created": True, "message": message}),
    )

    response = await namespace.on_project_chat_message_send(
        "browser-sid",
        {
            "projectId": "project-1",
            "taskId": "task-1",
            "clientMessageId": "client-1",
            "content": "hello",
        },
    )

    assert response["result"] == message
    assert namespace.emit.await_count == 1
    assert namespace.emit.await_args_list[0].kwargs["room"] == (
        "wework-project-chat:task:project-1:task-1"
    )


@pytest.mark.asyncio
async def test_project_chat_agent_start_creates_one_streaming_message(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    message = {
        "sequenceNumber": 6,
        "messageId": "agent-message-6",
        "projectId": "project-1",
        "taskId": None,
        "status": "streaming",
    }
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "user_name": "Ada"}),
    )
    monkeypatch.setattr(namespace, "emit", AsyncMock())
    start = AsyncMock(return_value=message)
    monkeypatch.setattr(wework_runtime_namespace, "run_sync_in_executor", start)

    response = await namespace.on_project_chat_agent_start(
        "browser-sid",
        {
            "projectId": "project-1",
            "triggerMessageId": "message-5",
            "agentId": "12",
            "runtimeDeviceId": "device-1",
            "runtimeTaskId": "runtime-task-1",
        },
    )

    assert response == {"ok": True, "result": message}
    start.assert_awaited_once()
    namespace.emit.assert_awaited_once_with(
        "wework:project_chat:message:created",
        message,
        room="wework-project-chat:project:project-1",
    )


@pytest.mark.asyncio
async def test_project_chat_wegent_continue_dispatches_native_turn(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    message = {
        "sequenceNumber": 7,
        "messageId": "wegent-continuation-7",
        "projectId": "project-1",
        "taskId": "task-1",
        "status": "pending",
    }
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "user_name": "Ada"}),
    )
    monkeypatch.setattr(namespace, "emit", AsyncMock())
    start = AsyncMock(
        return_value=SimpleNamespace(
            message=SimpleNamespace(
                model_dump=MagicMock(return_value=message),
            ),
            created=True,
        )
    )
    monkeypatch.setattr(
        "app.services.board_team_continuation.board_team_continuation_service.start",
        start,
    )

    response = await namespace.on_project_chat_wegent_continue(
        "browser-sid",
        {
            "projectId": "project-1",
            "taskId": "task-1",
            "triggerMessageId": "user-message-6",
            "agentId": "agent-1",
        },
    )

    assert response == {"ok": True, "result": message}
    start.assert_awaited_once()
    namespace.emit.assert_awaited_once_with(
        "wework:project_chat:message:created",
        message,
        room="wework-project-chat:task:project-1:task-1",
    )
