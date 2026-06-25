# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the local app IPC sidecar socket."""

import asyncio
import json
import os
import sys
from unittest.mock import patch

import pytest

from executor.modes.local.app_ipc import AppIpcServer, app_ipc_socket_path
from executor.modes.local.runner import LocalRunner


@pytest.mark.asyncio
async def test_app_ipc_routes_runtime_rpc_request():
    class RuntimeHandler:
        async def handle_runtime_rpc(self, data):
            assert data == {
                "method": "runtime.tasks.list",
                "payload": {"workspacePath": "/tmp/project"},
            }
            return {"success": True, "workspaces": []}

    server = AppIpcServer(
        runtime_work_handler=RuntimeHandler(),
    )

    response = await server.handle_line(
        json.dumps(
            {
                "type": "request",
                "id": "req-1",
                "method": "runtime.tasks.list",
                "params": {"workspacePath": "/tmp/project"},
            }
        )
    )

    assert response == {
        "type": "response",
        "id": "req-1",
        "ok": True,
        "result": {"success": True, "workspaces": []},
    }


@pytest.mark.asyncio
async def test_app_ipc_emits_runtime_events_with_device_id():
    server = AppIpcServer(device_id="device-1")

    event = server._event_message(
        "response.output_text.delta",
        {"local_task_id": "task-1", "data": {"delta": "hi"}},
    )

    assert event == {
        "type": "event",
        "event": "response.output_text.delta",
        "payload": {
            "device_id": "device-1",
            "local_task_id": "task-1",
            "data": {"delta": "hi"},
        },
    }


@pytest.mark.asyncio
async def test_app_ipc_resolves_configured_device_command():
    class CommandHandler:
        def __init__(self):
            self.payload = None

        async def handle_execute_command(self, data):
            self.payload = data
            return {
                "success": True,
                "exit_code": 0,
                "stdout": ".\n..\nsrc/\nREADME.md\n",
                "stderr": "",
                "duration": 0.01,
                "timed_out": False,
                "stdout_truncated": False,
                "stderr_truncated": False,
            }

    command_handler = CommandHandler()
    server = AppIpcServer(
        command_handler=command_handler,
    )

    response = await server.handle_line(
        json.dumps(
            {
                "type": "request",
                "id": "req-2",
                "method": "device.execute_command",
                "params": {
                    "command_key": "ls_dirs",
                    "path": "/tmp/project",
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096,
                },
            }
        )
    )

    assert command_handler.payload == {
        "command": "ls -a -p",
        "argv": ["ls", "-a", "-p"],
        "cwd": "/tmp/project",
        "env": {},
        "timeout_seconds": 10,
        "max_output_bytes": 4096,
    }
    assert response is not None
    assert response["result"]["stdout"] == ["src"]


@pytest.mark.asyncio
async def test_app_ipc_unknown_method_returns_protocol_error():
    server = AppIpcServer()

    response = await server.handle_line(
        json.dumps(
            {
                "type": "request",
                "id": "req-3",
                "method": "unknown.method",
                "params": {},
            }
        )
    )

    assert response is not None
    assert response["ok"] is False
    assert response["error"]["code"] == "unsupported_method"


def test_executor_cli_has_no_app_ipc_transport_flags():
    from executor.main import _parse_args

    with patch.object(sys, "argv", ["main.py"]):
        args = _parse_args()

    assert not hasattr(args, "app_ipc")
    assert not hasattr(args, "no_backend")


def test_executor_defaults_to_local_sidecar_without_backend_config(tmp_path):
    from executor.main import (
        _should_run_docker_server,
        _should_run_local_mode,
    )

    config_path = tmp_path / "missing-device-config.json"
    with patch.dict(os.environ, {}, clear=True):
        assert _should_run_docker_server(str(config_path)) is False
        assert _should_run_local_mode(str(config_path)) is True


def test_executor_uses_local_sidecar_when_backend_url_is_configured(tmp_path):
    from executor.main import _should_run_local_mode

    config_path = tmp_path / "device-config.json"
    config_path.write_text(
        json.dumps(
            {
                "mode": "local",
                "connection": {
                    "backend_url": "https://wegent.example.com",
                    "auth_token": "token",
                },
            }
        ),
        encoding="utf-8",
    )

    with patch.dict(os.environ, {}, clear=True):
        assert _should_run_local_mode(str(config_path)) is True


def test_executor_backend_url_env_selects_local_sidecar_without_config(tmp_path):
    from executor.main import _should_run_local_mode

    config_path = tmp_path / "missing-device-config.json"
    with patch.dict(
        os.environ,
        {"WEGENT_BACKEND_URL": "https://wegent.example.com"},
        clear=True,
    ):
        assert _should_run_local_mode(str(config_path)) is True


def test_executor_docker_mode_disables_default_local_sidecar(tmp_path):
    from executor.main import (
        _should_run_docker_server,
        _should_run_local_mode,
    )

    config_path = tmp_path / "device-config.json"
    config_path.write_text(json.dumps({"mode": "docker"}), encoding="utf-8")

    with patch.dict(os.environ, {}, clear=True):
        assert _should_run_docker_server(str(config_path)) is True
        assert _should_run_local_mode(str(config_path)) is False


def test_app_ipc_socket_path_can_be_overridden(tmp_path):
    socket_path = tmp_path / "executor.sock"

    with patch.dict(os.environ, {"WEGENT_EXECUTOR_APP_IPC_SOCKET": str(socket_path)}):
        assert app_ipc_socket_path() == socket_path


@pytest.mark.asyncio
async def test_local_runner_runtime_events_broadcast_to_backend_and_app():
    backend_events = []
    app_events = []

    class WebSocketClient:
        connected = True

        async def emit(self, event, payload):
            backend_events.append((event, payload))

    async def emit_app(event, payload):
        app_events.append((event, payload))

    runner = LocalRunner.__new__(LocalRunner)
    runner.websocket_client = WebSocketClient()
    runner.app_event_emitter = emit_app

    await LocalRunner._emit_runtime_work_event(
        runner, "response.created", {"task_id": 1}
    )

    assert backend_events == [("response.created", {"task_id": 1})]
    assert app_events == [("response.created", {"task_id": 1})]


@pytest.mark.asyncio
async def test_app_ipc_runner_cancels_local_runner_when_socket_server_stops():
    from executor.main import _run_local_runner_with_app_ipc

    events = []

    class Runner:
        async def start(self):
            events.append("runner:start")
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                events.append("runner:cancelled")
                raise

    class Server:
        def stop(self):
            events.append("server:stop")

        async def wait_closed(self):
            events.append("server:closed")

        async def serve_forever(self):
            events.append("server:serve_forever")

    await _run_local_runner_with_app_ipc(Runner(), Server())

    assert events == [
        "runner:start",
        "server:serve_forever",
        "server:stop",
        "server:closed",
        "runner:cancelled",
    ]
