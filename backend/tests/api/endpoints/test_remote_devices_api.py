# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for remote device Docker onboarding APIs."""

from types import SimpleNamespace

import pytest

from app.api.endpoints import remote_devices
from app.models.api_key import APIKey
from app.models.kind import Kind


class _FakeRequest:
    def __init__(self, host: str = "testserver", scheme: str = "http"):
        self.headers = {
            "host": host,
            "authorization": "Bearer jwt.current.user",
        }
        self.url = SimpleNamespace(scheme=scheme, netloc=host)


@pytest.mark.asyncio
async def test_create_docker_start_command_creates_credentials_without_device_crd(
    monkeypatch,
    test_db,
    test_user,
):
    """Docker onboarding should create credentials without adding an offline device."""
    monkeypatch.setattr(
        remote_devices.settings,
        "BACKEND_INTERNAL_URL",
        "https://backend.current.example",
    )

    response = await remote_devices.create_docker_start_command(
        request=_FakeRequest(host="localhost:8000"),
        body=remote_devices.CreateDockerRemoteDeviceRequest(
            client_origin="http://localhost:1420",
        ),
        db=test_db,
        current_user=test_user,
    )

    device = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == response.device_id,
            Kind.is_active == True,
        )
        .one_or_none()
    )
    assert device is None
    assert response.env["WEGENT_AUTH_TOKEN"].startswith("wg-")
    assert response.env["DEVICE_TYPE"] == "remote"
    assert response.env["WEGENT_BACKEND_URL"] == "https://backend.current.example"
    assert response.env["DEVICE_PUBLIC_BASE_URL"] == "http://localhost:17888"
    assert "--add-host host.docker.internal:host-gateway" not in response.command
    assert "DEVICE_TYPE=remote" in response.command
    assert f"WEGENT_AUTH_TOKEN={response.env['WEGENT_AUTH_TOKEN']}" in response.command
    assert "<host-ip>" not in response.command
    assert [command.kind for command in response.commands] == ["docker", "process"]
    assert response.commands[0].command == response.command
    assert "local_executor_install.sh" in response.commands[1].command
    assert 'curl -fsSL "$INSTALL_URL" | bash' in response.commands[1].command
    assert 'nohup "$EXECUTOR_BIN"' in response.commands[1].command
    assert "$EXECUTOR_HOME/bin/wegent-executor" in response.commands[1].command
    assert (
        "DEVICE_PUBLIC_BASE_URL=http://localhost:17888" in response.commands[1].command
    )

    api_key = (
        test_db.query(APIKey)
        .filter(
            APIKey.user_id == test_user.id,
            APIKey.name == f"{test_user.user_name}-remote-device",
            APIKey.is_active == True,
        )
        .one()
    )
    assert api_key.key_prefix.startswith("wg-")
    assert api_key.description == "Auto-generated for remote Docker device"


@pytest.mark.asyncio
async def test_create_docker_start_command_uses_current_system_urls(
    monkeypatch,
    test_db,
    test_user,
):
    """Docker onboarding should derive command URLs from current runtime context."""
    monkeypatch.setattr(
        remote_devices,
        "create_api_key_for_remote_device",
        lambda db, user_id, user_name: ("key-id", "wg-remote-token"),
    )
    monkeypatch.setattr(
        remote_devices,
        "DEFAULT_REMOTE_DEVICE_BACKEND_URL",
        "https://backend.example.com/api",
    )

    response = await remote_devices.create_docker_start_command(
        request=_FakeRequest(host="backend.example.com", scheme="https"),
        body=remote_devices.CreateDockerRemoteDeviceRequest(
            client_origin="https://app.example.com",
        ),
        db=test_db,
        current_user=test_user,
    )

    assert response.env["WEGENT_BACKEND_URL"] == "https://backend.example.com"
    assert response.env["DEVICE_PUBLIC_BASE_URL"] == "http://app.example.com:17888"
    assert "--add-host host.docker.internal:host-gateway" not in response.command
