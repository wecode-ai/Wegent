# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Native Git command identity on the Backend-to-executor Socket.IO boundary."""

import shlex
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.services.device import command_service
from app.services.device.command_registry import DEFAULT_LOCAL_DEVICE_COMMANDS


@pytest.fixture(params=["local", "cloud", "remote"])
def branch_device_type(request: pytest.FixtureRequest) -> str:
    return request.param


@pytest.fixture
def branch_socket(
    branch_device_type: str, monkeypatch: pytest.MonkeyPatch
) -> AsyncMock:
    spec: dict[str, Any] = {"deviceType": branch_device_type}
    if branch_device_type == "cloud":
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
@pytest.mark.parametrize("command_key", ["git_branch", "git_branch_list", "git_clone"])
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
    args = (
        ["--branch", "main", "--single-branch", "https://git.example/repo.git", "/repo"]
        if command_key == "git_clone"
        else []
    )
    env = {"GIT_TERMINAL_PROMPT": "0"}

    result = await command_service.execute_configured_device_command(
        db=object(),
        user_id=7,
        device_id="branch-device",
        command_key=command_key,
        path="/workspace/repo",
        args=args,
        env=env,
        command_config=overrides if config_source == "request" else None,
    )

    branch_socket.assert_awaited_once()
    event, payload = branch_socket.await_args.args
    assert event == "device:execute_command"
    assert payload["command"] == command
    assert payload["argv"] == shlex.split(command) + args
    assert payload["args"] == args
    assert payload["env"] == env
    assert payload["cwd"] == "/workspace/repo"
    assert branch_socket.await_args.kwargs["namespace"] == "/local-executor"
    if override == "default":
        assert payload["command_key"] == command_key
    else:
        assert "command_key" not in payload
    assert result["success"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("command_key", ["git_branch", "git_branch_list", "git_clone"])
@pytest.mark.parametrize(
    "override", ["default", "same_string", "same_object", "custom"]
)
async def test_runtime_relay_preserves_builtin_branch_identity(
    monkeypatch: pytest.MonkeyPatch,
    branch_socket: AsyncMock,
    branch_device_type: str,
    command_key: str,
    override: str,
) -> None:
    from app.api.ws import wework_runtime_namespace as relay

    default_command = DEFAULT_LOCAL_DEVICE_COMMANDS[command_key].command
    command = "git --version" if override == "custom" else default_command
    configured = {}
    if override != "default":
        configured[command_key] = (
            {"command": command} if override == "same_object" else command
        )
    monkeypatch.setattr(relay.settings, "LOCAL_DEVICE_COMMANDS", configured)
    monkeypatch.setattr(
        relay.runtime_route_resolver,
        "resolve",
        AsyncMock(
            return_value=SimpleNamespace(
                runtime_device_id="branch-device", device_type=branch_device_type
            )
        ),
    )
    args = (
        ["--branch", "main", "--single-branch", "https://git.example/repo.git", "/repo"]
        if command_key == "git_clone"
        else []
    )
    env = {"GIT_TERMINAL_PROMPT": "0"}

    result = await relay.relay_ipc_request(
        user_id=7,
        device_id="logical-device",
        method="device.execute_command",
        params={
            "command_key": command_key,
            "cwd": "/workspace/repo",
            "args": args,
            "env": env,
        },
        timeout_seconds=30,
    )

    branch_socket.assert_awaited_once()
    event, payload = branch_socket.await_args.args
    assert event == "device:execute_command"
    assert payload["command"] == command
    assert payload["argv"] == shlex.split(command) + args
    assert payload["args"] == args
    assert payload["env"] == env
    assert payload["cwd"] == "/workspace/repo"
    if override == "default":
        assert payload["command_key"] == command_key
    else:
        assert "command_key" not in payload
    assert result["success"] is True
