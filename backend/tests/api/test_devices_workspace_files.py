# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""File access outside registered workspaces over the device command API."""

import base64
import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException


@pytest.mark.asyncio
@pytest.mark.parametrize("device_type", ["local", "cloud", "remote"])
@pytest.mark.parametrize(
    ("command_key", "path", "args"),
    [
        ("workspace_tree", "/", []),
        ("workspace_read_text_file", "/home/ubuntu", ["README.md"]),
        ("workspace_read_file_chunk", "/home/ubuntu", ["sunset.png", "0"]),
    ],
)
async def test_file_commands_dispatch_without_workspace_registration(
    monkeypatch, device_type, command_key, path, args
):
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest
    from app.services.device import command_service

    device = SimpleNamespace(
        name="owned-device",
        json={
            "spec": {
                "deviceType": device_type,
                "cloudConfig": {"deviceId": "cloud-runtime"},
            }
        },
    )
    resolve_device = Mock(return_value=device)
    monkeypatch.setattr(
        command_service.device_service, "get_device_by_device_id", resolve_device
    )
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_online_info_by_type",
        AsyncMock(return_value={"socket_id": "socket-device"}),
    )
    execute = AsyncMock(
        return_value={
            "success": True,
            "exit_code": 0,
            "stdout": {"path": path},
            "stderr": "",
            "duration": 0.01,
            "timed_out": False,
        }
    )
    monkeypatch.setattr(
        command_service.local_device_command_service, "execute_command", execute
    )
    runtime_rpc = AsyncMock()
    monkeypatch.setattr(devices.runtime_rpc_service, "call", runtime_rpc)
    db = object()

    response = await devices.execute_device_command(
        "owned-device",
        DeviceCommandRequest(
            command_key=command_key, path=path, args=args, env={"EXISTING": "1"}
        ),
        db=db,
        current_user=SimpleNamespace(id=7),
    )

    assert response.success is True
    resolve_device.assert_called_once_with(db, 7, "owned-device")
    runtime_rpc.assert_not_awaited()
    execute.assert_awaited_once()
    dispatched = execute.await_args.kwargs
    assert dispatched["device_id"] == (
        "cloud-runtime" if device_type == "cloud" else "owned-device"
    )
    assert dispatched["path"] == path
    assert dispatched["args"] == args
    assert dispatched["env"] == {"EXISTING": "1"}
    assert dispatched["command_key"] == command_key


@pytest.mark.asyncio
async def test_file_commands_still_reject_unowned_devices(monkeypatch):
    from app.api.endpoints import devices
    from app.schemas.device import DeviceCommandRequest
    from app.services.device import command_service

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        Mock(return_value=None),
    )
    execute = AsyncMock()
    monkeypatch.setattr(
        command_service.local_device_command_service, "execute_command", execute
    )

    with pytest.raises(HTTPException) as error:
        await devices.execute_device_command(
            "unowned-device",
            DeviceCommandRequest(command_key="workspace_tree", path="/"),
            db=object(),
            current_user=SimpleNamespace(id=7),
        )

    assert error.value.status_code == 404
    execute.assert_not_awaited()


@pytest.mark.parametrize(
    ("command_key", "args"),
    [
        ("workspace_tree", []),
        ("workspace_read_text_file", ["README.md"]),
        ("workspace_read_file_chunk", ["sunset.png", "0"]),
    ],
)
def test_file_scripts_read_parent_of_workspace(
    monkeypatch, tmp_path, capsys, command_key, args
):
    from app.services.device import command_registry

    (tmp_path / "test").mkdir()
    (tmp_path / "README.md").write_text("hello", encoding="utf-8")
    (tmp_path / "sunset.png").write_bytes(b"image")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("WEGENT_WORKSPACE_ROOTS", str(tmp_path / "test"))
    monkeypatch.setattr(sys, "argv", [command_key, *args])
    scripts = {
        "workspace_tree": command_registry.WORKSPACE_TREE_SCRIPT,
        "workspace_read_text_file": command_registry.WORKSPACE_READ_TEXT_FILE_SCRIPT,
        "workspace_read_file_chunk": command_registry.WORKSPACE_READ_FILE_CHUNK_SCRIPT,
    }

    exec(scripts[command_key], {"__name__": "__main__"})
    output = json.loads(capsys.readouterr().out)

    if command_key == "workspace_tree":
        assert {entry["name"] for entry in output["entries"]} == {
            "test",
            "README.md",
            "sunset.png",
        }
    elif command_key == "workspace_read_text_file":
        assert output["content"] == "hello"
    else:
        assert base64.b64decode(output["content_base64"]) == b"image"
        assert output["eof"] is True
