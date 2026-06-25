# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the local app IPC stdio bridge."""

import io
import json
import sys
from unittest.mock import patch

import pytest

from executor.modes.local.app_ipc import AppIpcServer


def _json_lines(output: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in output.getvalue().splitlines()]


@pytest.mark.asyncio
async def test_app_ipc_routes_runtime_rpc_request():
    class RuntimeHandler:
        async def handle_runtime_rpc(self, data):
            assert data == {
                "method": "runtime.tasks.list",
                "payload": {"workspacePath": "/tmp/project"},
            }
            return {"success": True, "workspaces": []}

    output = io.StringIO()
    server = AppIpcServer(
        output=output,
        runtime_work_handler=RuntimeHandler(),
    )

    await server.handle_line(
        json.dumps(
            {
                "type": "request",
                "id": "req-1",
                "method": "runtime.tasks.list",
                "params": {"workspacePath": "/tmp/project"},
            }
        )
    )

    assert _json_lines(output) == [
        {
            "type": "response",
            "id": "req-1",
            "ok": True,
            "result": {"success": True, "workspaces": []},
        }
    ]


@pytest.mark.asyncio
async def test_app_ipc_emits_runtime_events_with_device_id():
    output = io.StringIO()
    server = AppIpcServer(output=output, device_id="device-1")

    await server.emit_event(
        "response.output_text.delta",
        {"local_task_id": "task-1", "data": {"delta": "hi"}},
    )

    assert _json_lines(output) == [
        {
            "type": "event",
            "event": "response.output_text.delta",
            "payload": {
                "device_id": "device-1",
                "local_task_id": "task-1",
                "data": {"delta": "hi"},
            },
        }
    ]


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
    output = io.StringIO()
    server = AppIpcServer(
        output=output,
        command_handler=command_handler,
    )

    await server.handle_line(
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
    assert _json_lines(output)[0]["result"]["stdout"] == ["src"]


@pytest.mark.asyncio
async def test_app_ipc_unknown_method_returns_protocol_error():
    output = io.StringIO()
    server = AppIpcServer(output=output)

    await server.handle_line(
        json.dumps(
            {
                "type": "request",
                "id": "req-3",
                "method": "unknown.method",
                "params": {},
            }
        )
    )

    response = _json_lines(output)[0]
    assert response["ok"] is False
    assert response["error"]["code"] == "unsupported_method"


def test_executor_cli_parses_app_ipc_flags():
    from executor.main import _parse_args

    with patch.object(sys, "argv", ["main.py", "--app-ipc", "--no-backend"]):
        args = _parse_args()

    assert args.app_ipc is True
    assert args.no_backend is True
