# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for WebSocket dispatch loop handling."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.device_socketio import publish_device_execution
from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import (
    CommunicationMode,
    ExecutionRouter,
    ExecutionTarget,
)
from shared.models import ExecutionRequest
from shared.models.execution import (
    GIT_AUTH_TRANSPORT_DEVICE_LOCAL,
    GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN,
)


@pytest.mark.asyncio
async def test_dispatch_allows_app_device_task_execution() -> None:
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        message_id=3,
        user={"id": 9, "name": "user9"},
        user_id=9,
        user_name="user9",
        bot=[{"shell_type": "ClaudeCode"}],
    )

    target = ExecutionTarget(
        mode=CommunicationMode.WEBSOCKET,
        namespace="/local-executor",
        event="task:execute",
        room="device:9:app-device",
    )
    with (
        patch.object(dispatcher, "_recover_executor_if_needed", AsyncMock()) as recover,
        patch.object(
            dispatcher,
            "_resolve_device_route_id",
            AsyncMock(return_value="app-device"),
        ),
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(dispatcher, "_dispatch_websocket", AsyncMock()) as dispatch,
    ):
        await dispatcher.dispatch(
            request,
            device_id="app-device",
            emitter=AsyncMock(),
        )

    recover.assert_awaited_once_with(request, device_id="app-device")
    dispatch.assert_awaited_once()


def test_worker_device_dispatch_uses_cross_process_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A worker must not consume its own event in an empty local room."""
    published = []

    class FakeRedis:
        def publish(self, channel, message):
            published.append((channel, message))

        def close(self):
            return None

    monkeypatch.setattr("redis.from_url", lambda *_args, **_kwargs: FakeRedis())

    publish_device_execution(
        event="task:execute",
        namespace="/local-executor",
        room="device:9:device-1",
        payload={"task_id": 1},
    )

    channel, raw_message = published[0]
    message = __import__("json").loads(raw_message)
    assert channel == "socketio"
    assert message["method"] == "emit"
    assert message["event"] == "task:execute"
    assert message["namespace"] == "/local-executor"
    assert message["room"] == "device:9:device-1"
    assert message["data"] == [{"task_id": 1}]
    assert message["host_id"]


async def test_app_device_routes_to_record_scoped_socket_room(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A desktop App alias must target the room joined at registration."""
    from app.models.kind import Kind
    from app.schemas.device import DeviceType

    device = Kind(
        id=58,
        user_id=9,
        kind="Device",
        name="e2e-platform-device-1",
        namespace="default",
        json={"spec": {"deviceType": DeviceType.APP.value}},
    )
    monkeypatch.setattr(
        "app.services.device_service.device_service.get_device_by_device_id",
        lambda _db, **_kwargs: device,
    )
    target_room = await ExecutionDispatcher()._resolve_device_route_id(
        MagicMock(user={"id": 9}), device.name
    )

    assert target_room == "app-record-58"


@pytest.mark.asyncio
async def test_dispatch_websocket_schedules_socket_emit_in_main_loop():
    """WebSocket dispatch should schedule Socket.IO emit in the main loop."""
    dispatcher = ExecutionDispatcher()
    request = MagicMock()
    request.task_id = 1
    request.subtask_id = 2
    request.message_id = 3
    request.user = {"id": 9}
    request.to_dict.return_value = {"task_id": 1}

    target = ExecutionTarget(
        mode=CommunicationMode.WEBSOCKET,
        namespace="/local-executor",
        event="task:execute",
        room="device:9:device-1",
    )
    emitter = AsyncMock()
    sio = MagicMock()

    with (
        patch(
            "app.core.socketio.get_sio",
            return_value=sio,
        ),
        patch.object(
            dispatcher,
            "_set_subtask_executor",
            AsyncMock(),
        ),
        patch(
            "app.services.execution.dispatcher.run_in_main_loop",
            AsyncMock(return_value=None),
        ) as run_in_main_loop_mock,
    ):
        await dispatcher._dispatch_websocket(request, target, emitter)

    emitter.emit_start.assert_awaited_once()
    run_in_main_loop_mock.assert_awaited_once()
    sio.emit.assert_not_called()


@pytest.mark.asyncio
async def test_dispatch_websocket_start_event_includes_current_bot_name():
    """WebSocket dispatch should identify the bot that owns the current subtask."""
    dispatcher = ExecutionDispatcher()
    request = MagicMock()
    request.task_id = 1
    request.subtask_id = 2
    request.message_id = 3
    request.user = {"id": 9}
    request.bot_name = ""
    request.bot = [{"name": "pipeline-bot", "shell_type": "ClaudeCode"}]
    request.to_dict.return_value = {"task_id": 1}

    target = ExecutionTarget(
        mode=CommunicationMode.WEBSOCKET,
        namespace="/local-executor",
        event="task:execute",
        room="device:9:device-1",
    )
    emitter = AsyncMock()

    with (
        patch.object(
            dispatcher,
            "_set_subtask_executor",
            AsyncMock(),
        ),
        patch.object(
            dispatcher,
            "_emit_socketio_in_main_loop",
            AsyncMock(),
        ),
    ):
        await dispatcher._dispatch_websocket(request, target, emitter)

    emitter.emit_start.assert_awaited_once_with(
        task_id=1,
        subtask_id=2,
        message_id=3,
        data={"shell_type": "ClaudeCode", "bot_name": "pipeline-bot"},
    )


@pytest.mark.asyncio
async def test_dispatch_websocket_passes_skill_identity_token_in_payload():
    """WebSocket dispatch should forward skill identity token to device payload."""
    dispatcher = ExecutionDispatcher()
    request = MagicMock()
    request.task_id = 1
    request.subtask_id = 2
    request.message_id = 3
    request.user = {"id": 9}
    request.to_dict.return_value = {
        "task_id": 1,
        "subtask_id": 2,
        "skill_identity_token": "skill-jwt",
    }

    target = ExecutionTarget(
        mode=CommunicationMode.WEBSOCKET,
        namespace="/local-executor",
        event="task:execute",
        room="device:9:device-1",
    )
    emitter = AsyncMock()

    with (
        patch.object(
            dispatcher,
            "_set_subtask_executor",
            AsyncMock(),
        ),
        patch.object(
            dispatcher,
            "_emit_socketio_in_main_loop",
            AsyncMock(),
        ) as emit_mock,
    ):
        await dispatcher._dispatch_websocket(request, target, emitter)

    payload = emit_mock.await_args.args[2]
    assert payload["skill_identity_token"] == "skill-jwt"


@pytest.mark.asyncio
async def test_dispatch_websocket_uses_git_credentials_configured_on_device() -> None:
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        message_id=3,
        user={
            "id": 9,
            "git_domain": "git.example.com",
            "git_token": "encrypted-token",
        },
        bot=[{"shell_type": "ClaudeCode"}],
        git_auth_transport=GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN,
    )
    target = ExecutionTarget(
        mode=CommunicationMode.WEBSOCKET,
        namespace="/local-executor",
        event="task:execute",
        room="device:9:device-1",
    )
    emitter = AsyncMock()

    with (
        patch.object(dispatcher, "_set_subtask_executor", AsyncMock()),
        patch.object(
            dispatcher,
            "_emit_socketio_in_main_loop",
            AsyncMock(),
        ) as emit_mock,
    ):
        await dispatcher._dispatch_websocket(request, target, emitter)

    payload = emit_mock.await_args.args[2]
    assert payload["git_auth_transport"] == GIT_AUTH_TRANSPORT_DEVICE_LOCAL
    assert "git_token" not in payload["user"]
    assert request.user["git_token"] == "encrypted-token"
