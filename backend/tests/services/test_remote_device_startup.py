# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contracts for stable Remote Docker device identity and storage."""

from app.core.config import settings
from app.services.device.remote_device_startup import (
    DefaultRemoteDeviceCommandProvider,
    RemoteDeviceCommandContext,
)


def _context() -> RemoteDeviceCommandContext:
    return RemoteDeviceCommandContext(
        container_name="remote-device-1",
        client_origin="https://app.example.com",
        request_scheme="https",
        request_netloc="backend.example.com",
        request_headers={"host": "backend.example.com"},
        device_id="device-stable-1",
        device_name="Remote Device",
        auth_token="wg-test-token",
    )


def test_remote_docker_command_binds_device_identity_to_stable_home(monkeypatch):
    monkeypatch.delenv("REMOTE_DEVICE_BACKEND_URL", raising=False)
    monkeypatch.delenv("REMOTE_DEVICE_DOCKER_IMAGE", raising=False)
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "")
    monkeypatch.setattr(settings, "WEGENT_SOCKET_URL", "")
    provider = DefaultRemoteDeviceCommandProvider()

    first = provider.build(_context())
    rebuilt = provider.build(_context())

    assert first.command == rebuilt.command
    assert first.env["DEVICE_ID"] == "device-stable-1"
    assert first.env["DEVICE_CODE_SERVER_ENABLED"] == "true"
    assert first.env["DEVICE_TERMINAL_ENABLED"] == "true"
    assert first.env["WEGENT_EXECUTOR_HOME_ID"] == "device-stable-1"
    assert first.env["WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED"] == "true"
    assert (
        "-v remote-device-1-home:/home/wegent/.wecode/wegent-executor" in first.command
    )
    assert "-e WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true" in first.command
    assert "-e DEVICE_CODE_SERVER_ENABLED=true" in first.command
    assert "-e DEVICE_TERMINAL_ENABLED=true" in first.command
    assert "WEGENT_EXECUTOR_HOME_ID" not in first.commands[1].command
    assert (
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED" not in first.commands[1].command
    )
