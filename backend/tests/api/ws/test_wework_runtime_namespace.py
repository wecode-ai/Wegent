# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Wework runtime IPC relay namespace."""

import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import BaseModel, field_validator

from app.api.ws import device_namespace, local_task_responses, wework_runtime_namespace
from app.api.ws.device_namespace import DeviceNamespace
from app.api.ws.wework_runtime_namespace import WeworkRuntimeNamespace
from app.core.socketio import SOCKETIO_MAX_HTTP_BUFFER_SIZE
from shared.telemetry.context import get_request_id


@pytest.mark.asyncio
async def test_project_chat_payload_validation_runs_off_event_loop() -> None:
    event_loop_thread = threading.get_ident()
    validation_threads: list[int] = []

    class ObservedProjectPayload(BaseModel):
        project_id: str

        @field_validator("project_id")
        @classmethod
        def observe_thread(cls, value: str) -> str:
            validation_threads.append(threading.get_ident())
            return value

    payload = await wework_runtime_namespace.validate_project_chat_payload(
        ObservedProjectPayload,
        {"projectId": "project-1"},
    )

    assert payload.project_id == "project-1"
    assert validation_threads
    assert all(thread_id != event_loop_thread for thread_id in validation_threads)


@pytest.mark.asyncio
async def test_runtime_event_only_forwards_authenticated_envelope(monkeypatch):
    namespace = DeviceNamespace()
    dispatch = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(
            return_value={
                "user_id": 7,
                "device_id": "physical-device",
                "logical_device_id": "logical-device",
            }
        ),
    )
    monkeypatch.setattr(
        device_namespace.stream_execution_client,
        "dispatch_runtime_event",
        dispatch,
    )
    payload = {
        "event": "response.output_text.delta",
        "payload": {"taskId": "runtime-1", "data": {"delta": "hello"}},
    }

    result = await namespace.on_runtime_event("device-sid", payload)

    assert result == {"success": True}
    dispatch.assert_awaited_once_with(
        user_id=7,
        device_id="physical-device",
        logical_device_id="logical-device",
        data=payload,
    )


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
    assert get_request_id() == "req-1"
    runtime_rpc.assert_awaited_once_with(
        user_id=7,
        device_id="cloud-device",
        method="runtime.tasks.create",
        payload={"message": "hello"},
        timeout_seconds=75,
    )


@pytest.mark.asyncio
async def test_runtime_request_binds_authenticated_execution_identity(monkeypatch):
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
        AsyncMock(
            return_value={
                "user_id": 7,
                "user_name": "hongyu9",
                "user_email": "hongyu9@example.com",
            }
        ),
    )

    response = await namespace.on_runtime_request(
        "browser-sid",
        {
            "id": "req-1",
            "device_id": "cloud-device",
            "method": "runtime.tasks.create",
            "params": {
                "executionRequest": {
                    "user": {
                        "id": 0,
                        "name": "local",
                        "user_name": "local",
                        "email": "local@localhost",
                        "preference": "preserved",
                    },
                    "user_id": 0,
                    "user_name": "local",
                },
                "friendlyTitleExecutionRequest": {
                    "user": {"id": 0, "name": "local"},
                    "user_id": 0,
                    "user_name": "local",
                },
            },
        },
    )

    assert response == {"id": "req-1", "ok": True, "result": {"accepted": True}}
    payload = runtime_rpc.await_args.kwargs["payload"]
    assert payload["executionRequest"]["user"] == {
        "id": 7,
        "name": "hongyu9",
        "user_name": "hongyu9",
        "email": "hongyu9@example.com",
        "preference": "preserved",
    }
    assert payload["executionRequest"]["user_id"] == 7
    assert payload["executionRequest"]["user_name"] == "hongyu9"
    assert payload["friendlyTitleExecutionRequest"]["user"] == {
        "id": 7,
        "name": "hongyu9",
        "user_name": "hongyu9",
        "email": "hongyu9@example.com",
    }
    assert payload["friendlyTitleExecutionRequest"]["user_id"] == 7
    assert payload["friendlyTitleExecutionRequest"]["user_name"] == "hongyu9"


@pytest.mark.asyncio
async def test_runtime_request_rejects_execution_without_authenticated_user_name(
    monkeypatch,
):
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
            "params": {"executionRequest": {"user_name": "local"}},
        },
    )

    assert response == {
        "id": "req-1",
        "ok": False,
        "error": {
            "code": "unauthorized",
            "message": "Authenticated runtime user identity is incomplete",
        },
    }
    runtime_rpc.assert_not_awaited()


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
async def test_device_command_relay_rejects_app_device_when_remote_control_is_disabled(
    monkeypatch,
):
    from app.schemas.device import DeviceType
    from app.services.device.runtime_route import RuntimeRoute

    route = RuntimeRoute(
        logical_device_id="app-device",
        runtime_device_id="app-device",
        runtime_instance_id="runtime-instance-1",
        device_type=DeviceType.APP,
        socket_id="socket-1",
        online_info={"socket_id": "socket-1"},
    )
    monkeypatch.setattr(
        wework_runtime_namespace.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=route),
    )
    execute = AsyncMock(return_value={"success": True})
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

    with pytest.raises(wework_runtime_namespace.RuntimeRpcError) as exc_info:
        await wework_runtime_namespace.relay_ipc_request(
            user_id=7,
            device_id="app-device",
            method="device.execute_command",
            params={"command_key": "pwd"},
            timeout_seconds=30,
        )

    assert exc_info.value.code == "remote_control_disabled"
    execute.assert_not_awaited()


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
        "app.services.board_team_continuation.board_team_continuation_service."
        "start_nonblocking",
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
