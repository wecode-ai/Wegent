# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for WebSocket dispatch loop handling."""

import asyncio
import threading
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.device.remote_control_policy import (
    REMOTE_CONTROL_DISABLED_MESSAGE,
    RemoteControlDisabledError,
)
from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.git_credentials import build_device_git_execution_payload
from app.services.execution.router import CommunicationMode, ExecutionTarget
from shared.models import ExecutionRequest
from shared.models.execution import (
    GIT_AUTH_TRANSPORT_DEVICE_LOCAL,
    GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN,
)


async def _wait_for_thread(started: threading.Event) -> None:
    while not started.is_set():
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_dispatch_rejects_app_only_device_before_task_emit():
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

    with (
        patch(
            "app.services.execution.dispatcher.ensure_remote_control_enabled_for_device",
            side_effect=RemoteControlDisabledError(REMOTE_CONTROL_DISABLED_MESSAGE),
        ) as ensure_remote_control,
        patch.object(dispatcher, "_recover_executor_if_needed", AsyncMock()) as recover,
        patch.object(dispatcher.router, "route") as route,
        patch.object(dispatcher, "_dispatch_websocket", AsyncMock()) as dispatch,
    ):
        with pytest.raises(
            RemoteControlDisabledError,
            match=REMOTE_CONTROL_DISABLED_MESSAGE,
        ):
            await dispatcher.dispatch(
                request,
                device_id="app-device",
                emitter=AsyncMock(),
            )

    ensure_remote_control.assert_called_once_with(
        user_id=9,
        device_id="app-device",
    )
    recover.assert_not_awaited()
    route.assert_not_called()
    dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_device_dispatch_never_recovers_server_executor_in_web() -> None:
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
        room="device:9:device-1",
    )

    with (
        patch(
            "app.services.execution.dispatcher.ensure_remote_control_enabled_for_device"
        ),
        patch.object(
            dispatcher,
            "_recover_executor_if_needed",
            AsyncMock(),
        ) as recover,
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_dispatch_to_target", AsyncMock()),
    ):
        await dispatcher.dispatch(
            request,
            device_id="device-1",
            emitter=AsyncMock(),
        )

    recover.assert_not_awaited()


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
        patch(
            "app.services.execution.dispatcher.run_payload_codec",
            AsyncMock(return_value={"task_id": 1}),
        ) as run_payload_codec_mock,
    ):
        await dispatcher._dispatch_websocket(request, target, emitter)

    emitter.emit_start.assert_awaited_once()
    run_in_main_loop_mock.assert_awaited_once()
    run_payload_codec_mock.assert_awaited_once_with(
        build_device_git_execution_payload,
        request,
        payload_hint=request,
        force_offload=True,
    )
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
async def test_set_subtask_executor_does_not_block_event_loop():
    """Device executor persistence must run outside the Socket.IO event loop."""
    dispatcher = ExecutionDispatcher()
    started = threading.Event()
    release = threading.Event()

    def blocking_set(*_args):
        started.set()
        release.wait()

    safety_release = threading.Timer(2, release.set)
    safety_release.start()
    try:
        with patch.object(
            dispatcher,
            "_set_subtask_executor_sync",
            side_effect=blocking_set,
        ):
            update = asyncio.create_task(
                dispatcher._set_subtask_executor(2, "device-1", 9)
            )
            await asyncio.wait_for(_wait_for_thread(started), timeout=0.5)
            assert not update.done()
            release.set()
            await update
    finally:
        release.set()
        safety_release.cancel()


@pytest.mark.asyncio
async def test_dispatch_websocket_uses_git_credentials_configured_on_device():
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
