# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.ws import device_namespace, local_task_responses
from app.services.device.terminal_session_service import TerminalSessionRecord
from shared.models import ExecutionEvent


def find_emit_call(sio, event_name: str):
    return next(call for call in sio.emit.await_args_list if call.args[0] == event_name)


def find_emit_calls(sio, event_name: str):
    return [call for call in sio.emit.await_args_list if call.args[0] == event_name]


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
async def test_response_like_event_name_routes_to_response_api_handler(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    handler = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(namespace, "_handle_responses_api_event", handler)

    result = await namespace._execute_handler(
        "future.response.delta",
        "sid-1",
        {
            "local_task_id": "codex-1",
            "subtask_id": 202,
            "data": {"delta": "hello"},
        },
    )

    assert result == {"success": True}
    handler.assert_awaited_once_with(
        "sid-1",
        "future.response.delta",
        {
            "local_task_id": "codex-1",
            "subtask_id": 202,
            "data": {"delta": "hello"},
        },
    )


@pytest.mark.asyncio
async def test_device_status_broadcast_reaches_frontend_and_wework_rooms(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    sio = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr(device_namespace, "get_sio", lambda: sio, raising=False)

    await namespace._broadcast_device_status(7, "device-1", "online")

    emit_calls = find_emit_calls(sio, "device:status")
    assert [call.kwargs["room"] for call in emit_calls] == ["user:7", "wework:user:7"]
    assert all(call.kwargs["namespace"] == "/chat" for call in emit_calls)


@pytest.mark.asyncio
async def test_heartbeat_runtime_auth_sync_uses_user_preferences(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    event_loop_thread = threading.get_ident()
    payload = device_namespace.RuntimeAuthSyncPayload(
        runtime="codex",
        target_path="~/.codex/auth.json",
        auth_json=json.dumps({"token": "secret"}),
    )

    def fake_load_payload(user_id, runtime):
        assert threading.get_ident() != event_loop_thread
        assert user_id == 7
        assert runtime == "codex"
        return payload

    sync_auth_payload_to_device = AsyncMock(
        return_value={
            "device_id": "device-1",
            "success": True,
            "status": "written",
        }
    )
    monkeypatch.setattr(
        device_namespace.user_runtime_config_service,
        "sync_auth_payload_to_device",
        sync_auth_payload_to_device,
    )
    monkeypatch.setattr(
        device_namespace,
        "_load_heartbeat_runtime_auth_payload",
        fake_load_payload,
    )

    key = (7, "device-1", "codex")
    namespace._runtime_auth_sync_inflight.add(key)

    await namespace._sync_runtime_auth_for_heartbeat_device(
        user_id=7,
        device_id="device-1",
        runtime="codex",
        key=key,
    )

    sync_auth_payload_to_device.assert_awaited_once_with(
        user_id=7,
        device_id="device-1",
        payload=payload,
    )
    assert key not in namespace._runtime_auth_sync_inflight


@pytest.mark.asyncio
async def test_registered_capability_sync_offloads_database_phases(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    event_loop_thread = threading.get_ident()
    payload = {"revision": 3}
    result = SimpleNamespace(success=True, error=None)
    phases = []

    def fake_prepare(user_id, device_id):
        assert threading.get_ident() != event_loop_thread
        phases.append("prepare")
        assert (user_id, device_id) == (7, "device-1")
        return payload

    async def fake_sync(**kwargs):
        assert threading.get_ident() == event_loop_thread
        phases.append("sync")
        assert kwargs["payload"] is payload
        return result

    def fake_record(user_id, recorded_result):
        assert threading.get_ident() != event_loop_thread
        phases.append("record")
        assert user_id == 7
        assert recorded_result is result

    monkeypatch.setattr(
        device_namespace,
        "_prepare_registered_device_capability_sync",
        fake_prepare,
    )
    monkeypatch.setattr(
        device_namespace.device_capability_sync_service,
        "sync_device_payload",
        fake_sync,
    )
    monkeypatch.setattr(
        device_namespace,
        "_record_registered_device_capability_sync",
        fake_record,
    )

    await namespace._sync_global_capabilities_to_registered_device(
        user_id=7,
        device_id="device-1",
    )

    assert phases == ["prepare", "sync", "record"]


@pytest.mark.asyncio
async def test_upgrade_status_admin_query_runs_off_event_loop(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    event_loop_thread = threading.get_ident()
    emit = AsyncMock()

    def fake_admin_ids():
        assert threading.get_ident() != event_loop_thread
        return [2, 3]

    monkeypatch.setattr(device_namespace, "_active_admin_user_ids", fake_admin_ids)
    monkeypatch.setattr(device_namespace, "emit_chat_user_event", emit)

    await namespace._broadcast_device_upgrade_status(
        7,
        SimpleNamespace(
            device_id="device-1",
            model_dump=lambda **_: {"device_id": "device-1", "status": "done"},
        ),
    )

    assert {call.kwargs["user_id"] for call in emit.await_args_list} == {2, 3, 7}


@pytest.mark.asyncio
async def test_responses_api_event_only_forwards_authenticated_envelope(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    dispatch = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )
    monkeypatch.setattr(
        device_namespace.stream_execution_client,
        "dispatch_device_event",
        dispatch,
    )
    payload = {
        "task_id": 101,
        "subtask_id": 202,
        "message_id": 303,
        "data": {"delta": "hello"},
    }

    result = await namespace._handle_responses_api_event(
        "sid-1",
        "response.output_text.delta",
        payload,
    )

    assert result == {"success": True}
    dispatch.assert_awaited_once_with(
        user_id=7,
        device_id="device-1",
        event_type="response.output_text.delta",
        data=payload,
    )


@pytest.mark.asyncio
async def test_runtime_task_update_only_forwards_authenticated_envelope(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    dispatch = AsyncMock(return_value={"success": True, "notified": 1})
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )
    monkeypatch.setattr(
        device_namespace.stream_execution_client,
        "dispatch_runtime_task_updated",
        dispatch,
    )
    payload = {
        "localTaskId": "codex-thread-1",
        "status": "done",
        "content": "Implemented",
    }

    result = await namespace.on_runtime_task_updated("sid-1", payload)

    assert result == {"success": True, "notified": 1}
    dispatch.assert_awaited_once_with(
        user_id=7,
        device_id="device-1",
        data=payload,
    )


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
