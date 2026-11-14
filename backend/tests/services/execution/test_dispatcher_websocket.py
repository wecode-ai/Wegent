# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for WebSocket dispatch loop handling."""

import asyncio
import threading
import time
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
@pytest.mark.parametrize("is_group_chat", [False, True])
async def test_dispatch_notifies_task_creation_from_request_metadata(
    is_group_chat: bool,
) -> None:
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        user={"id": 9},
        bot=[{"shell_type": "Chat"}],
        team_id=5,
        team_name="chat-team",
        task_title="Persisted task title",
        is_group_chat=is_group_chat,
        project_id=8,
    )
    target = ExecutionTarget(mode=CommunicationMode.SSE, url="http://chat-shell")
    ws_emitter = AsyncMock()

    async def start_execution(_request, _target, emitter):
        await emitter.emit_start(task_id=1, subtask_id=2)

    with (
        patch.object(dispatcher, "_recover_executor_if_needed", AsyncMock()),
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch.object(dispatcher, "_dispatch_sse", side_effect=start_execution),
        patch(
            "app.services.chat.storage.session_manager.set_task_streaming_status",
            AsyncMock(),
        ),
        patch(
            "app.services.chat.webpage_ws_chat_emitter.get_webpage_ws_emitter",
            return_value=ws_emitter,
        ),
    ):
        await dispatcher.dispatch(request)

    ws_emitter.emit_task_created.assert_awaited_once_with(
        user_id=9,
        task_id=1,
        title="Persisted task title",
        team_id=5,
        team_name="chat-team",
        is_group_chat=is_group_chat,
        project_id=8,
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


@pytest.mark.asyncio
async def test_worker_device_dispatch_uses_cross_process_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A worker must not consume its own event in an empty local room."""
    published = []

    class FakeRedis:
        def publish(self, channel, message):
            published.append((channel, message))

        def close(self):
            return None

    options = {}

    def create_client(*_args, **kwargs):
        options.update(kwargs)
        return FakeRedis()

    monkeypatch.setattr("redis.from_url", create_client)

    await publish_device_execution(
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
    assert options["socket_timeout"] == 1.0
    assert options["socket_connect_timeout"] == 1.0


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["slow", "error", "timeout"])
async def test_device_publish_keeps_main_loop_responsive(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    started = threading.Event()
    release = threading.Event()

    class BlockingRedis:
        def publish(self, _channel, _message):
            started.set()
            if failure == "error":
                raise RuntimeError("Redis unavailable")
            if failure == "slow":
                time.sleep(0.15)
                return
            release.wait(2)

        def close(self):
            return None

    monkeypatch.setattr("redis.from_url", lambda *_args, **_kwargs: BlockingRedis())
    monkeypatch.setattr(
        "app.services.execution.device_socketio._REDIS_PUBLISH_TIMEOUT_SECONDS",
        0.05,
    )
    publishing = asyncio.create_task(
        publish_device_execution(
            event="task:execute",
            namespace="/",
            room="room",
            payload={},
        )
    )
    await asyncio.to_thread(started.wait, 1)
    heartbeat_started = time.monotonic()
    await asyncio.sleep(0.01)
    heartbeat_delay = time.monotonic() - heartbeat_started

    assert heartbeat_delay < 0.1
    if failure == "slow":
        await publishing
    else:
        with pytest.raises((RuntimeError, TimeoutError)):
            await publishing
    release.set()


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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("online", "failing_write", "initial_status", "terminal_status"),
    [
        (False, None, "PENDING", "FAILED"),
        (True, None, "PENDING", "FAILED"),
        (False, "subtask", "PENDING", "FAILED"),
        (False, "task", "PENDING", "FAILED"),
        (False, None, "CANCELLED", "CANCELLED"),
    ],
)
async def test_device_dispatch_failure_persists_terminal_state(
    test_db, online, failing_write, initial_status, terminal_status
):
    from sqlalchemy.exc import OperationalError
    from sqlalchemy.orm import Session

    from app.models.subtask import Subtask, SubtaskStatus
    from app.models.task import TaskResource
    from app.stores.tasks import subtask_store, task_store

    task = TaskResource(
        user_id=9,
        kind="Task",
        name="device-turn",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": "device-turn", "namespace": "default"},
            "spec": {
                "title": "Device turn",
                "prompt": "Run on device",
                "device_id": "device-1",
                "teamRef": {"name": "device-test-team"},
                "workspaceRef": {"name": "device-test-workspace"},
            },
            "status": {"status": initial_status},
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    test_db.add(task)
    test_db.flush()
    subtask = Subtask(
        user_id=9,
        task_id=task.id,
        team_id=1,
        title="Device turn",
        bot_ids=[],
        status=SubtaskStatus(initial_status),
    )
    test_db.add(subtask)
    test_db.commit()
    subtask_id = subtask.id
    task_id = task.id
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(
        task_id=task.id,
        subtask_id=subtask_id,
        message_id=1,
        user={"id": 9},
        bot=[{"shell_type": "ClaudeCode"}],
    )
    target = ExecutionTarget(
        mode=CommunicationMode.WEBSOCKET,
        namespace="/local-executor",
        event="task:execute",
        room="device:9:device-1",
    )
    delivery = AsyncMock(side_effect=RuntimeError("Redis publish failed"))
    from types import SimpleNamespace

    from app.schemas.device_chat_task import DeviceChatTaskRequest
    from app.services.device_chat_task_service import _run_ai_response

    async def dispatch_turn(**kwargs):
        await dispatcher.dispatch(request, device_id=kwargs["device_id"])

    update = subtask_store.update_fields_if_status
    update_task = task_store.update_json
    connection = test_db.get_bind()

    def session():
        return Session(bind=connection, join_transaction_mode="create_savepoint")

    failed_once = False

    def persist(db, **kwargs):
        nonlocal failed_once
        if failing_write == "subtask" and not failed_once:
            failed_once = True
            raise OperationalError("UPDATE", {}, RuntimeError("connection reset"))
        return update(db, **kwargs)

    def persist_task(db, **kwargs):
        nonlocal failed_once
        if failing_write == "task" and not failed_once:
            failed_once = True
            assert db.get(Subtask, subtask_id).status == SubtaskStatus.FAILED
            raise OperationalError("UPDATE", {}, RuntimeError("connection reset"))
        return update_task(db, **kwargs)

    notifications = AsyncMock()
    with (
        patch.object(subtask_store, "update_fields_if_status", side_effect=persist),
        patch.object(task_store, "update_json", side_effect=persist_task),
        patch(
            "app.services.chat.webpage_ws_chat_emitter.get_webpage_ws_emitter",
            return_value=notifications,
        ),
        patch(
            "app.services.device_chat_task_service.trigger_ai_response_unified",
            side_effect=dispatch_turn,
        ),
        patch("app.services.execution.dispatcher.SessionLocal", side_effect=session),
        patch("app.db.session.SessionLocal", side_effect=session),
        patch(
            "app.services.chat.storage.session_manager.cleanup_streaming_state",
            AsyncMock(),
        ),
        patch.object(dispatcher, "_recover_executor_if_needed", AsyncMock()),
        patch.object(
            dispatcher, "_resolve_device_route_id", AsyncMock(return_value="device-1")
        ),
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_emit_socketio_in_main_loop", delivery),
        patch(
            "app.services.execution.dispatcher.lock_online_device_for_binding",
            return_value="device-1" if online else None,
        ),
        patch(
            "app.services.execution.emitters.status_updating.collect_completed_result",
            AsyncMock(return_value={}),
        ),
    ):
        await _run_ai_response(
            task=task,
            assistant_subtask=subtask,
            team=SimpleNamespace(id=1),
            user=SimpleNamespace(id=9),
            message="Run on device",
            payload=DeviceChatTaskRequest(teamId=1, message="Run on device"),
            device_id="device-1",
            user_subtask_id=0,
            auth_token="",
        )

    test_db.expire_all()
    subtask = test_db.get(Subtask, subtask_id)
    assert subtask is not None
    assert failed_once == (failing_write is not None)
    assert subtask.status == SubtaskStatus(terminal_status)
    assert (
        test_db.get(TaskResource, task_id).json["status"]["status"] == terminal_status
    )
    if terminal_status == "FAILED":
        notifications.emit_chat_error.assert_awaited_once()
        assert notifications.emit_chat_error.await_args.kwargs["task_id"] == task_id
        assert (
            notifications.emit_chat_error.await_args.kwargs["subtask_id"] == subtask_id
        )
        notifications.emit_task_status.assert_awaited_once_with(
            user_id=9, task_id=task_id, status="FAILED"
        )
    else:
        notifications.emit_chat_error.assert_not_awaited()
        notifications.emit_task_status.assert_not_awaited()
    if online:
        delivery.assert_awaited_once()
    else:
        delivery.assert_not_awaited()
        assert subtask.executor_name is None
