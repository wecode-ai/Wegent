# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.ws import device_namespace, local_task_responses
from app.services.device.terminal_session_service import TerminalSessionRecord


@pytest.mark.asyncio
async def test_store_device_capabilities_state_preserves_plugin_report(monkeypatch):
    stored = {}

    async def fake_store(user_id, device_id, capabilities):
        stored["user_id"] = user_id
        stored["device_id"] = device_id
        stored["capabilities"] = capabilities
        return True

    monkeypatch.setattr(
        device_namespace.device_service,
        "get_device_capabilities_state",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        device_namespace.device_service,
        "store_device_capabilities_state",
        fake_store,
    )

    await device_namespace._store_device_capabilities_state(
        1,
        "device-1",
        {
            "revision": 2,
            "digest": "sha256:test",
            "full": True,
            "skills": [{"name": "browser", "source": "local_user"}],
            "mcps": [{"name": "docs", "source": "wegent"}],
            "plugins": [
                {
                    "name": "context7",
                    "marketplace": "claude-plugins-official",
                    "scope": "user",
                    "version": "1057d02c5307",
                    "source": "local_user",
                }
            ],
        },
    )

    assert stored["capabilities"]["plugins"] == [
        {
            "name": "context7",
            "marketplace": "claude-plugins-official",
            "scope": "user",
            "version": "1057d02c5307",
            "source": "local_user",
        }
    ]


def test_runtime_auth_file_missing_requires_explicit_false():
    assert (
        device_namespace._runtime_auth_file_missing(
            {"codex": {"exists": False}},
            "codex",
        )
        is True
    )
    assert (
        device_namespace._runtime_auth_file_missing(
            {"codex": {"exists": True}},
            "codex",
        )
        is False
    )
    assert device_namespace._runtime_auth_file_missing({}, "codex") is False
    assert device_namespace._runtime_auth_file_missing(None, "codex") is False


def test_runtime_subtask_id_fallback_is_scoped_by_device():
    first = local_task_responses.runtime_subtask_id({}, "device-a", "codex-1")
    second = local_task_responses.runtime_subtask_id({}, "device-b", "codex-1")

    assert first != second
    assert (
        local_task_responses.runtime_subtask_id(
            {"subtask_id": 202},
            "device-b",
            "codex-1",
        )
        == 202
    )


@pytest.mark.asyncio
async def test_heartbeat_runtime_auth_sync_delegates_master_slave_policy(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    user = SimpleNamespace(
        id=7,
        preferences=json.dumps(
            {"runtime_configs": {"codex": {"use_user_config": True}}}
        ),
    )
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = user

    @contextmanager
    def fake_db_session():
        yield db

    runtime_auth_files = {
        "codex": {
            "exists": True,
            "sha256": "sha256:test",
            "modified_at": "2026-06-23T02:00:00+00:00",
        }
    }
    sync_auth_for_heartbeat_device = AsyncMock(return_value={"status": "slave_synced"})
    monkeypatch.setattr(device_namespace, "_db_session", fake_db_session)
    monkeypatch.setattr(
        device_namespace.user_runtime_config_service,
        "sync_auth_for_heartbeat_device",
        sync_auth_for_heartbeat_device,
    )

    key = (7, "device-1", "codex")
    namespace._runtime_auth_sync_inflight.add(key)

    await namespace._sync_runtime_auth_for_heartbeat_device(
        user_id=7,
        device_id="device-1",
        runtime="codex",
        key=key,
        runtime_auth_files=runtime_auth_files,
    )

    sync_auth_for_heartbeat_device.assert_awaited_once_with(
        db,
        user_id=7,
        runtime="codex",
        device_id="device-1",
        runtime_auth_files=runtime_auth_files,
        preferences=user.preferences,
    )
    assert key not in namespace._runtime_auth_sync_inflight


@pytest.mark.asyncio
async def test_responses_api_terminal_event_logs_callback_summary(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    event = SimpleNamespace(
        type=device_namespace.EventType.DONE.value,
        result={"content": "done"},
    )
    payload = {
        "task_id": 101,
        "subtask_id": 202,
        "message_id": 303,
        "data": {"output": [{"type": "text", "text": "done"}]},
    }
    messages = []
    completed_event_args = []

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    def fake_parse(**kwargs):
        return event

    class FakeWebSocketResultEmitter:
        def __init__(self, **kwargs):
            assert kwargs["user_id"] == 7
            pass

    class FakeStatusUpdatingEmitter:
        def __init__(self, **kwargs):
            assert "owner_user_id" not in kwargs
            pass

        async def emit(self, emitted_event):
            assert emitted_event is event

        async def close(self):
            pass

    async def fake_publish_task_completed_event(*args):
        completed_event_args.append(args)

    async def fake_broadcast_slot_update(*args):
        pass

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(namespace._event_parser, "parse", fake_parse)
    monkeypatch.setattr(
        device_namespace,
        "WebSocketResultEmitter",
        FakeWebSocketResultEmitter,
    )
    monkeypatch.setattr(
        device_namespace,
        "StatusUpdatingEmitter",
        FakeStatusUpdatingEmitter,
    )
    monkeypatch.setattr(
        namespace,
        "_publish_task_completed_event",
        fake_publish_task_completed_event,
    )
    monkeypatch.setattr(
        namespace,
        "_broadcast_device_slot_update",
        fake_broadcast_slot_update,
    )
    monkeypatch.setattr(
        device_namespace.logger,
        "info",
        lambda message: messages.append(message),
    )

    result = await namespace._handle_responses_api_event(
        "sid-1", "response.completed", payload
    )

    assert result == {"success": True}
    assert completed_event_args[0][2] == 7
    assert any(
        "[Device WS] Terminal callback received:" in message
        and "task_id=101" in message
        and "subtask_id=202" in message
        for message in messages
    )
    assert all("done" not in message for message in messages)


@pytest.mark.asyncio
async def test_responses_api_delta_event_forwards_to_channel_callbacks(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    event = SimpleNamespace(
        type=device_namespace.EventType.CHUNK.value,
        content="hi",
        offset=2,
    )
    payload = {
        "task_id": 101,
        "subtask_id": 202,
        "message_id": 303,
        "data": {"delta": "hi"},
    }
    forwarded_events = []

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    def fake_parse(**kwargs):
        return event

    class FakeWebSocketResultEmitter:
        def __init__(self, **kwargs):
            assert kwargs["user_id"] == 7

    class FakeStatusUpdatingEmitter:
        def __init__(self, **kwargs):
            pass

        async def emit(self, emitted_event):
            assert emitted_event is event

        async def close(self):
            pass

    async def fake_forward_event_to_channel_callbacks(
        *, task_id, subtask_id, event, source
    ):
        assert source == "Device WS"
        forwarded_events.append((task_id, subtask_id, event))

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(namespace._event_parser, "parse", fake_parse)
    monkeypatch.setattr(
        device_namespace,
        "WebSocketResultEmitter",
        FakeWebSocketResultEmitter,
    )
    monkeypatch.setattr(
        device_namespace,
        "StatusUpdatingEmitter",
        FakeStatusUpdatingEmitter,
    )
    monkeypatch.setattr(
        device_namespace,
        "forward_event_to_channel_callbacks",
        fake_forward_event_to_channel_callbacks,
        raising=False,
    )

    result = await namespace._handle_responses_api_event(
        "sid-1", "response.output_text.delta", payload
    )

    assert result == {"success": True}
    assert forwarded_events == [(101, 202, event)]


@pytest.mark.asyncio
async def test_local_task_reasoning_event_emits_chat_chunk(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    sio = SimpleNamespace(emit=AsyncMock())

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(local_task_responses, "get_sio", lambda: sio, raising=False)

    result = await namespace._handle_responses_api_event(
        "sid-1",
        "response.reasoning_summary_text.delta",
        {
            "subtask_id": 202,
            "local_task_id": "codex-1",
            "runtime": "codex",
            "data": {"delta": "Reading files"},
        },
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once()
    event_name, payload = sio.emit.await_args.args[:2]
    assert event_name == device_namespace.ServerEvents.CHAT_CHUNK
    assert payload["device_id"] == "device-1"
    assert payload["local_task_id"] == "codex-1"
    assert payload["content"] == ""
    assert payload["result"] == {"reasoning_chunk": "Reading files"}


@pytest.mark.asyncio
async def test_local_task_tool_event_emits_block_created(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    sio = SimpleNamespace(emit=AsyncMock())

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(local_task_responses, "get_sio", lambda: sio, raising=False)

    result = await namespace._handle_responses_api_event(
        "sid-1",
        "response.output_item.added",
        {
            "subtask_id": 202,
            "local_task_id": "codex-1",
            "runtime": "codex",
            "data": {
                "item": {
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "shell",
                    "arguments": "{}",
                }
            },
        },
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once()
    event_name, payload = sio.emit.await_args.args[:2]
    assert event_name == device_namespace.ServerEvents.CHAT_BLOCK_CREATED
    assert payload["device_id"] == "device-1"
    assert payload["local_task_id"] == "codex-1"
    assert payload["block"]["type"] == "tool"
    assert payload["block"]["tool_name"] == "shell"


@pytest.mark.asyncio
async def test_local_task_streaming_tool_arguments_emit_generating_block(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    sio = SimpleNamespace(emit=AsyncMock())

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(local_task_responses, "get_sio", lambda: sio, raising=False)

    result = await namespace._handle_responses_api_event(
        "sid-1",
        "response.output_item.added",
        {
            "subtask_id": 202,
            "local_task_id": "claude-1",
            "runtime": "claude_code",
            "data": {
                "item": {
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "Bash",
                    "arguments": "{}",
                },
                "argument_status": "streaming",
            },
        },
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once()
    event_name, payload = sio.emit.await_args.args[:2]
    assert event_name == device_namespace.ServerEvents.CHAT_BLOCK_CREATED
    assert payload["device_id"] == "device-1"
    assert payload["local_task_id"] == "claude-1"
    assert payload["block"]["type"] == "tool"
    assert payload["block"]["tool_name"] == "Bash"
    assert payload["block"]["status"] == "generating_arguments"


@pytest.mark.asyncio
async def test_local_task_im_source_forwards_stream_event_to_channel_callbacks(
    monkeypatch,
):
    namespace = device_namespace.DeviceNamespace()
    sio = SimpleNamespace(emit=AsyncMock())
    forwarded_events = []

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    async def fake_forward_event_to_channel_callbacks(
        *, task_id, subtask_id, event, source
    ):
        forwarded_events.append((task_id, subtask_id, event, source))

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(local_task_responses, "get_sio", lambda: sio, raising=False)
    monkeypatch.setattr(
        local_task_responses,
        "forward_event_to_channel_callbacks",
        fake_forward_event_to_channel_callbacks,
        raising=False,
    )

    result = await namespace._handle_responses_api_event(
        "sid-1",
        "response.output_text.delta",
        {
            "subtask_id": 202,
            "local_task_id": "codex-1",
            "runtime": "codex",
            "source": {
                "source": "im",
                "external_id": "session-1",
                "channel_type": "telegram",
                "channel_id": 10,
                "conversation_id": "12345",
                "sender_id": "sender-1",
            },
            "data": {"delta": "hello"},
        },
    )

    assert result == {"success": True}
    assert len(forwarded_events) == 1
    task_id, subtask_id, event, source = forwarded_events[0]
    assert task_id == "runtime:device-1:codex-1"
    assert subtask_id == 202
    assert event.type == device_namespace.EventType.CHUNK.value
    assert event.content == "hello"
    assert source == "Device WS local task"


@pytest.mark.asyncio
async def test_runtime_task_updated_event_notifies_im_dispatcher(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    notifications = []

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    async def fake_send_runtime_task_update(**kwargs):
        notifications.append(kwargs)
        return {"sent": 1}

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(
        device_namespace.im_notification_dispatcher,
        "send_runtime_task_update_for_user",
        fake_send_runtime_task_update,
    )

    result = await namespace.on_runtime_task_updated(
        "sid-1",
        {
            "localTaskId": "codex-thread-1",
            "runtime": "codex",
            "title": "Native Codex task",
            "updatedAt": "2026-06-21T01:06:00Z",
            "status": "done",
            "content": "Implemented from native Codex",
        },
    )

    assert result == {"success": True, "notified": 1}
    assert notifications[0]["user_id"] == 7
    assert notifications[0]["address"] == {
        "deviceId": "device-1",
        "localTaskId": "codex-thread-1",
    }
    assert notifications[0]["source"] == "codex_watcher"
    assert notifications[0]["title"] == "Native Codex task"
    assert notifications[0]["status"] == "done"
    assert notifications[0]["content"] == "Implemented from native Codex"


@pytest.mark.asyncio
async def test_runtime_task_updated_event_skips_im_notification_until_terminal(
    monkeypatch,
):
    namespace = device_namespace.DeviceNamespace()
    notifications = []

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    async def fake_send_runtime_task_update(**kwargs):
        notifications.append(kwargs)
        return {"sent": 1}

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(
        device_namespace.im_notification_dispatcher,
        "send_runtime_task_update_for_user",
        fake_send_runtime_task_update,
    )

    result = await namespace.on_runtime_task_updated(
        "sid-1",
        {
            "localTaskId": "codex-thread-1",
            "runtime": "codex",
            "title": "Native Codex task",
            "updatedAt": "2026-06-21T01:06:00Z",
            "status": "streaming",
            "content": "Partial response",
        },
    )

    assert result == {"success": True, "notified": 0, "skipped": "non_terminal"}
    assert notifications == []


@pytest.mark.asyncio
async def test_runtime_task_updated_event_skips_success_notification_without_content(
    monkeypatch,
):
    namespace = device_namespace.DeviceNamespace()
    notifications = []

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    async def fake_send_runtime_task_update(**kwargs):
        notifications.append(kwargs)
        return {"sent": 1}

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(
        device_namespace.im_notification_dispatcher,
        "send_runtime_task_update_for_user",
        fake_send_runtime_task_update,
    )

    result = await namespace.on_runtime_task_updated(
        "sid-1",
        {
            "localTaskId": "codex-thread-1",
            "runtime": "codex",
            "title": "Native Codex task",
            "updatedAt": "2026-06-21T01:06:00Z",
            "status": "done",
        },
    )

    assert result == {"success": True, "notified": 0, "skipped": "empty_content"}
    assert notifications == []


@pytest.mark.asyncio
async def test_local_task_responses_api_events_are_serialized(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    first_event_started = asyncio.Event()
    emitted_chunks = []

    async def fake_get_session(sid):
        return {"user_id": 7, "device_id": "device-1"}

    async def fake_emit_local_task_execution_event(**kwargs):
        event = kwargs["event"]
        if event.content == "first":
            first_event_started.set()
            await asyncio.sleep(0.05)
        emitted_chunks.append(event.content)

    async def fake_forward_local_task_event_to_channel_callbacks(**kwargs):
        return None

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(
        namespace._local_task_responses,
        "emit_execution_event",
        fake_emit_local_task_execution_event,
    )
    monkeypatch.setattr(
        namespace._local_task_responses,
        "forward_channel_callbacks",
        fake_forward_local_task_event_to_channel_callbacks,
    )

    first = asyncio.create_task(
        namespace._handle_responses_api_event(
            "sid-1",
            "response.output_text.delta",
            {
                "subtask_id": 202,
                "local_task_id": "codex-1",
                "runtime": "codex",
                "data": {"delta": "first"},
            },
        )
    )
    await asyncio.wait_for(first_event_started.wait(), timeout=1)
    second = await namespace._handle_responses_api_event(
        "sid-1",
        "response.output_text.delta",
        {
            "subtask_id": 202,
            "local_task_id": "codex-1",
            "runtime": "codex",
            "data": {"delta": "second"},
        },
    )
    first_result = await first

    assert first_result == {"success": True}
    assert second == {"success": True}
    assert emitted_chunks == ["first", "second"]


@pytest.mark.asyncio
async def test_device_terminal_output_forwards_to_browser_terminal_room(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    record = TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-1",
        socket_id="device-sid",
        project_id=123,
        path="/repo",
        expires_at=None,
    )
    service = SimpleNamespace(get=AsyncMock(return_value=record))
    sio = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr(device_namespace, "terminal_session_service", service)
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio, raising=False)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )

    result = await namespace.on_terminal_output(
        "device-sid",
        {"session_id": "terminal-1", "data": "hello"},
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once_with(
        "terminal:output",
        {"session_id": "terminal-1", "data": "hello"},
        room="terminal:terminal-1",
        namespace="/terminal",
    )


@pytest.mark.asyncio
async def test_device_terminal_output_rejects_mismatched_device(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    record = TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-1",
        socket_id="device-sid",
        project_id=123,
        path="/repo",
        expires_at=None,
    )
    service = SimpleNamespace(get=AsyncMock(return_value=record))
    monkeypatch.setattr(device_namespace, "terminal_session_service", service)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "other-device"}),
    )

    result = await namespace.on_terminal_output(
        "device-sid",
        {"session_id": "terminal-1", "data": "hello"},
    )

    assert result == {"error": "Terminal session does not belong to this device"}


@pytest.mark.asyncio
async def test_device_terminal_exit_forwards_and_deletes_session(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    record = TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-1",
        socket_id="device-sid",
        project_id=123,
        path="/repo",
        expires_at=None,
    )
    service = SimpleNamespace(
        get=AsyncMock(return_value=record),
        delete=AsyncMock(),
    )
    sio = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr(device_namespace, "terminal_session_service", service)
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio, raising=False)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )

    result = await namespace.on_terminal_exit(
        "device-sid",
        {"session_id": "terminal-1", "exit_code": 0},
    )

    assert result == {"success": True}
    sio.emit.assert_awaited_once_with(
        "terminal:exit",
        {"session_id": "terminal-1", "exit_code": 0},
        room="terminal:terminal-1",
        namespace="/terminal",
    )
    service.delete.assert_awaited_once_with("terminal-1")


@pytest.mark.asyncio
async def test_device_terminal_exit_deletes_session_when_forwarding_fails(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    record = TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-1",
        socket_id="device-sid",
        project_id=123,
        path="/repo",
        expires_at=None,
    )
    service = SimpleNamespace(
        get=AsyncMock(return_value=record),
        delete=AsyncMock(),
    )
    sio = SimpleNamespace(emit=AsyncMock(side_effect=RuntimeError("emit failed")))
    monkeypatch.setattr(device_namespace, "terminal_session_service", service)
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio, raising=False)
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )

    with pytest.raises(RuntimeError, match="emit failed"):
        await namespace.on_terminal_exit(
            "device-sid",
            {"session_id": "terminal-1", "exit_code": 0},
        )

    service.delete.assert_awaited_once_with("terminal-1")
