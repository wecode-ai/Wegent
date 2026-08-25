# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Wework runtime IPC relay namespace."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.ws import device_namespace, local_task_responses, wework_runtime_namespace
from app.api.ws.device_namespace import DeviceNamespace
from app.api.ws.wework_runtime_namespace import WeworkRuntimeNamespace
from app.core.socketio import SOCKETIO_MAX_HTTP_BUFFER_SIZE


@pytest.fixture(autouse=True)
def runtime_notification_sender(monkeypatch):
    """Keep namespace tests isolated from notification DB and provider I/O."""

    sender = AsyncMock(return_value={"sent": 0, "results": []})
    monkeypatch.setattr(
        device_namespace.im_notification_dispatcher,
        "send_runtime_task_update_for_user",
        sender,
    )
    return sender


def _im_source() -> dict:
    return {
        "source": "im",
        "channel_type": "dingtalk",
        "external_id": "dingtalk:conversation-1:user-1",
    }


async def _relay_runtime_event(namespace, monkeypatch, payload: dict) -> dict:
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "local-device"}),
    )
    monkeypatch.setattr(
        device_namespace,
        "run_sync_in_executor",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(device_namespace, "get_sio", lambda: AsyncMock())
    return await namespace.on_runtime_event(
        "device-sid",
        {"type": "event", "event": payload["event_type"], "payload": payload},
    )


@pytest.mark.asyncio
async def test_runtime_event_forwards_im_chunk_to_channel_callbacks(monkeypatch):
    """IM-originated native runtime output must reach the channel emitter.

    The native runtime relays its stream only as ``runtime:event`` envelopes,
    so the relay path itself has to feed the IM callbacks; otherwise the
    DingTalk AI card stays on its placeholder forever.
    """

    namespace = DeviceNamespace()
    forward = AsyncMock()
    monkeypatch.setattr(
        local_task_responses, "forward_event_to_channel_callbacks", forward
    )

    result = await _relay_runtime_event(
        namespace,
        monkeypatch,
        {
            "event_type": "response.output_text.delta",
            "taskId": "runtime-375023196",
            "subtaskId": "runtime-375023196",
            "data": {"delta": "Hi!", "offset": 3},
            "source": _im_source(),
        },
    )

    assert result == {"success": True}
    forward.assert_awaited_once()
    kwargs = forward.await_args.kwargs
    assert kwargs["task_id"] == "runtime:local-device:runtime-375023196"
    assert kwargs["event"].content == "Hi!"
    assert kwargs["subtask_id"] == kwargs["event"].subtask_id > 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event_type", "event_data", "expected_type"),
    [
        (
            "response.reasoning_summary_text.delta",
            {"delta": "Inspecting the workspace"},
            "thinking",
        ),
        (
            "response.block.created",
            {
                "block": {
                    "id": "tool-1",
                    "type": "tool",
                    "tool_name": "Read",
                    "status": "pending",
                }
            },
            "block_created",
        ),
    ],
)
async def test_runtime_event_forwards_im_progress_events_to_channel_callbacks(
    monkeypatch,
    event_type,
    event_data,
    expected_type,
):
    namespace = DeviceNamespace()
    forward = AsyncMock()
    monkeypatch.setattr(
        local_task_responses, "forward_event_to_channel_callbacks", forward
    )

    result = await _relay_runtime_event(
        namespace,
        monkeypatch,
        {
            "event_type": event_type,
            "taskId": "runtime-375023196",
            "subtaskId": "runtime-375023196",
            "data": event_data,
            "source": _im_source(),
        },
    )

    assert result == {"success": True}
    event = forward.await_args.kwargs["event"]
    assert event.type == expected_type
    if expected_type == "thinking":
        assert event.content == "Inspecting the workspace"
    else:
        assert event.data["block"]["tool_name"] == "Read"


@pytest.mark.asyncio
async def test_runtime_event_completes_im_channel_callback_on_terminal_event(
    monkeypatch,
    runtime_notification_sender,
):
    """The native runtime reports its answer as ``data.value``, not a response body."""

    namespace = DeviceNamespace()
    registry = MagicMock()
    registry.handle_task_completed = AsyncMock()
    monkeypatch.setattr(local_task_responses, "get_callback_registry", lambda: registry)

    result = await _relay_runtime_event(
        namespace,
        monkeypatch,
        {
            "event_type": "response.completed",
            "taskId": "runtime-375023196",
            "data": {"value": "Hi! What would you like to work on?"},
            "source": _im_source(),
        },
    )

    assert result == {"success": True}
    registry.handle_task_completed.assert_awaited_once()
    kwargs = registry.handle_task_completed.await_args.kwargs
    assert kwargs["task_id"] == "runtime:local-device:runtime-375023196"
    assert kwargs["status"] == "COMPLETED"
    assert kwargs["result"] == {"value": "Hi! What would you like to work on?"}
    runtime_notification_sender.assert_not_awaited()


@pytest.mark.asyncio
async def test_runtime_event_fails_im_channel_callback_on_failed_event(
    monkeypatch,
    runtime_notification_sender,
):
    """``response.failed`` must release the card instead of leaving it pending."""

    namespace = DeviceNamespace()
    registry = MagicMock()
    registry.handle_task_completed = AsyncMock()
    monkeypatch.setattr(local_task_responses, "get_callback_registry", lambda: registry)

    result = await _relay_runtime_event(
        namespace,
        monkeypatch,
        {
            "event_type": "response.failed",
            "taskId": "runtime-375023196",
            "data": {"error": {"message": "model request timed out"}},
            "source": _im_source(),
        },
    )

    assert result == {"success": True}
    kwargs = registry.handle_task_completed.await_args.kwargs
    assert kwargs["status"] == "FAILED"
    assert kwargs["error"] == "model request timed out"
    runtime_notification_sender.assert_not_awaited()


@pytest.mark.asyncio
async def test_runtime_event_skips_channel_callbacks_without_im_source(monkeypatch):
    namespace = DeviceNamespace()
    forward = AsyncMock()
    registry = MagicMock()
    registry.handle_task_completed = AsyncMock()
    monkeypatch.setattr(
        local_task_responses, "forward_event_to_channel_callbacks", forward
    )
    monkeypatch.setattr(local_task_responses, "get_callback_registry", lambda: registry)

    result = await _relay_runtime_event(
        namespace,
        monkeypatch,
        {
            "event_type": "response.output_text.delta",
            "taskId": "runtime-375023196",
            "data": {"delta": "Hi!"},
        },
    )

    assert result == {"success": True}
    forward.assert_not_awaited()
    registry.handle_task_completed.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event_type", "event_data", "expected_status", "expected_content"),
    [
        (
            "response.completed",
            {"value": "Codex finished the task"},
            "COMPLETED",
            "Codex finished the task",
        ),
        (
            "response.completed",
            {
                "response": {
                    "output": [
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "Claude finished the task",
                                }
                            ]
                        }
                    ]
                }
            },
            "COMPLETED",
            "Claude finished the task",
        ),
        (
            "response.failed",
            {"error": {"message": "model request timed out"}},
            "FAILED",
            "model request timed out",
        ),
        (
            "response.incomplete",
            {"error": {"message": "turn cancelled"}},
            "CANCELLED",
            "turn cancelled",
        ),
        (
            "error",
            {"message": "Claude transport failed"},
            "FAILED",
            "Claude transport failed",
        ),
    ],
)
async def test_runtime_terminal_event_notifies_im_dispatcher(
    monkeypatch,
    runtime_notification_sender,
    event_type,
    event_data,
    expected_status,
    expected_content,
):
    namespace = DeviceNamespace()

    result = await _relay_runtime_event(
        namespace,
        monkeypatch,
        {
            "event_type": event_type,
            "taskId": "runtime-375023196",
            "taskTitle": "分析线上问题",
            "data": event_data,
        },
    )

    assert result == {"success": True}
    runtime_notification_sender.assert_awaited_once_with(
        user_id=7,
        address={
            "deviceId": "local-device",
            "localTaskId": "runtime-375023196",
        },
        title="分析线上问题",
        status=expected_status,
        content=expected_content,
        source=None,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event_type", "event_data"),
    [
        ("response.output_text.delta", {"delta": "still running"}),
        ("response.completed", {"value": ""}),
        ("response.completed", {"response": {"output": []}}),
    ],
)
async def test_runtime_event_skips_non_terminal_or_empty_success_notifications(
    monkeypatch,
    runtime_notification_sender,
    event_type,
    event_data,
):
    namespace = DeviceNamespace()

    result = await _relay_runtime_event(
        namespace,
        monkeypatch,
        {
            "event_type": event_type,
            "taskId": "runtime-375023196",
            "data": event_data,
        },
    )

    assert result == {"success": True}
    runtime_notification_sender.assert_not_awaited()


@pytest.mark.asyncio
async def test_runtime_notification_failure_does_not_break_wework_relay(
    monkeypatch,
    runtime_notification_sender,
):
    namespace = DeviceNamespace()
    sio = AsyncMock()
    runtime_notification_sender.side_effect = RuntimeError("DingTalk unavailable")
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "local-device"}),
    )
    monkeypatch.setattr(
        device_namespace,
        "run_sync_in_executor",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio)

    result = await namespace.on_runtime_event(
        "device-sid",
        {
            "event": "response.completed",
            "payload": {
                "taskId": "runtime-375023196",
                "data": {"value": "Task finished"},
            },
        },
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once()
    assert sio.emit.await_args.args[0] == "runtime:event"


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
async def test_runtime_request_compresses_large_result_for_wework(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    namespace = WeworkRuntimeNamespace()
    runtime_rpc = AsyncMock(
        return_value={
            "success": True,
            "messages": [{"id": "m1", "content": "历史消息🙂" * 100000}],
        }
    )
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
            "method": "runtime.tasks.transcript",
            "params": {"localTaskId": "runtime-1"},
        },
    )

    assert response["ok"] is True
    assert response["result"]["__runtimeRpcEncoding"] == "gzip+base64+json"
    encoded_response = json.dumps(
        response,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    assert len(encoded_response) < SOCKETIO_MAX_HTTP_BUFFER_SIZE


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
            "retryable": False,
        },
    }


@pytest.mark.asyncio
async def test_runtime_request_preserves_stable_runtime_rpc_error(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    monkeypatch.setattr(
        wework_runtime_namespace.runtime_rpc_service,
        "call",
        AsyncMock(
            side_effect=wework_runtime_namespace.RuntimeRpcError(
                "Device is offline",
                code="device_offline",
                retryable=True,
                details={"deviceId": "cloud-device"},
            )
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
            "method": "runtime.tasks.create",
            "params": {"message": "hello"},
        },
    )

    assert response == {
        "id": "req-1",
        "ok": False,
        "error": {
            "code": "device_offline",
            "message": "Device is offline",
            "retryable": True,
            "details": {"deviceId": "cloud-device"},
        },
    }


@pytest.mark.asyncio
async def test_runtime_request_preserves_executor_error_code(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    monkeypatch.setattr(
        wework_runtime_namespace.runtime_rpc_service,
        "call",
        AsyncMock(
            return_value={
                "success": False,
                "error": {
                    "code": "workspace_not_git",
                    "message": "Workspace is not a Git repository",
                    "retryable": False,
                },
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
            "method": "runtime.worktrees.preflight",
            "params": {"sourcePath": "/workspace/project"},
        },
    )

    assert response["error"] == {
        "code": "workspace_not_git",
        "message": "Workspace is not a Git repository",
        "retryable": False,
    }


@pytest.mark.asyncio
async def test_device_command_relay_resolves_logical_device_route(monkeypatch):
    from app.schemas.device import DeviceType
    from app.services.device.runtime_route import RuntimeRoute

    route = RuntimeRoute(
        logical_device_id="cloud-logical",
        runtime_device_id="runtime-cloud",
        runtime_instance_id="runtime-instance-1",
        device_type=DeviceType.CLOUD,
        socket_id="socket-1",
        online_info={"socket_id": "socket-1"},
    )
    monkeypatch.setattr(
        wework_runtime_namespace.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=route),
    )
    execute = AsyncMock(return_value={"success": True, "stdout": "/workspace"})
    monkeypatch.setattr(
        wework_runtime_namespace.local_device_command_service,
        "execute_command",
        execute,
    )
    monkeypatch.setattr(
        wework_runtime_namespace,
        "resolve_local_device_command",
        lambda *_args: SimpleNamespace(command="pwd"),
    )

    result = await wework_runtime_namespace.relay_ipc_request(
        user_id=7,
        device_id="cloud-logical",
        method="device.execute_command",
        params={"command_key": "pwd"},
        timeout_seconds=30,
    )

    assert result == {"success": True, "stdout": "/workspace"}
    execute.assert_awaited_once()
    assert execute.await_args.kwargs["device_id"] == "runtime-cloud"


@pytest.mark.asyncio
async def test_runtime_request_relays_device_command_nonzero_exit(monkeypatch):
    """A device command that runs but exits non-zero is a valid result.

    ``device.execute_command`` is a pass-through executor command: a
    ``success: False`` envelope means the command exited non-zero (e.g.
    ``git_is_worktree`` intentionally exits 1 on a non-git directory), not
    that the RPC transport failed. It must be relayed verbatim so the client
    can interpret the exit code, matching the local desktop IPC path.
    """

    namespace = WeworkRuntimeNamespace()
    command_result = {"success": False, "stdout": "false", "stderr": ""}
    monkeypatch.setattr(
        wework_runtime_namespace,
        "relay_ipc_request",
        AsyncMock(return_value=command_result),
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
            "method": "device.execute_command",
            "params": {"command_key": "git_is_worktree", "args": ["/home/ubuntu"]},
        },
    )

    assert response == {"id": "req-1", "ok": True, "result": command_result}


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


@pytest.mark.asyncio
async def test_project_chat_manager_continue_opens_custom_manager_reply(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    assert (
        namespace._event_handlers["wework:project_chat:manager:continue"]
        == "on_project_chat_manager_continue"
    )
    message = {
        "sequenceNumber": 8,
        "messageId": "manager-continuation-8",
        "projectId": "project-1",
        "taskId": "task-1",
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

    response = await namespace.on_project_chat_manager_continue(
        "browser-sid",
        {
            "projectId": "project-1",
            "taskId": "task-1",
            "triggerMessageId": "user-message-7",
            "managerMessageId": "manager-message-1",
        },
    )

    assert response == {"ok": True, "result": message}
    start.assert_awaited_once()
    namespace.emit.assert_awaited_once_with(
        "wework:project_chat:message:created",
        message,
        room="wework-project-chat:task:project-1:task-1",
    )
