# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Branch command identity on the Backend-to-executor Socket.IO boundary."""

import shlex
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.services.device import command_service
from app.services.device.command_registry import DEFAULT_LOCAL_DEVICE_COMMANDS


@pytest.fixture(params=["local", "cloud", "remote"])
def branch_socket(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> AsyncMock:
    spec: dict[str, Any] = {"deviceType": request.param}
    if request.param == "cloud":
        spec["cloudConfig"] = {"deviceId": "runtime-cloud"}
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: SimpleNamespace(json={"spec": spec}),
    )
    for method in ["get_device_online_info", "get_device_online_info_by_type"]:
        monkeypatch.setattr(
            command_service.device_service,
            method,
            AsyncMock(return_value={"socket_id": "branch-socket"}),
        )
    call = AsyncMock(return_value={"success": True, "stdout": "main\n", "stderr": ""})
    monkeypatch.setattr(command_service, "get_sio", lambda: SimpleNamespace(call=call))
    return call


@pytest.mark.asyncio
@pytest.mark.parametrize("command_key", ["git_branch", "git_branch_list"])
@pytest.mark.parametrize("config_source", ["global", "request"])
@pytest.mark.parametrize(
    "override", ["default", "same_string", "same_object", "custom"]
)
async def test_branch_identity_preserves_configured_overrides(
    monkeypatch: pytest.MonkeyPatch,
    branch_socket: AsyncMock,
    command_key: str,
    config_source: str,
    override: str,
) -> None:
    default_command = DEFAULT_LOCAL_DEVICE_COMMANDS[command_key].command
    command = "git --version" if override == "custom" else default_command
    overrides: dict[str, Any] = {}
    if override != "default":
        overrides[command_key] = (
            {"command": command} if override == "same_object" else command
        )
    global_commands = overrides if config_source == "global" else {command_key: "pwd"}
    monkeypatch.setattr(
        command_service.settings, "LOCAL_DEVICE_COMMANDS", global_commands
    )

    result = await command_service.execute_configured_device_command(
        db=object(),
        user_id=7,
        device_id="branch-device",
        command_key=command_key,
        path="/workspace/repo",
        command_config=overrides if config_source == "request" else None,
    )

    branch_socket.assert_awaited_once()
    event, payload = branch_socket.await_args.args
    assert event == "device:execute_command"
    assert payload["command"] == command
    assert payload["argv"] == shlex.split(command)
    assert payload["cwd"] == "/workspace/repo"
    assert branch_socket.await_args.kwargs["namespace"] == "/local-executor"
    if override == "default":
        assert payload["command_key"] == command_key
    else:
        assert "command_key" not in payload
    assert result["success"] is True
