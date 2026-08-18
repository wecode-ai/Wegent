# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the open-source remote device onboarding provider."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.endpoints import remote_devices
from app.core.config import settings
from app.models.api_key import APIKey
from app.models.kind import Kind
from app.services.device.remote_device_startup import (
    DefaultRemoteDeviceCommandProvider,
    RemoteDeviceCommandContext,
    get_remote_device_command_provider,
    register_remote_device_command_provider,
)


class _FakeRequest:
    def __init__(self, host: str = "testserver", scheme: str = "http") -> None:
        self.headers = {
            "host": host,
            "authorization": "Bearer jwt.current.user",
        }
        self.url = SimpleNamespace(scheme=scheme, netloc=host)


@pytest.fixture(autouse=True)
def use_default_remote_device_provider(monkeypatch):
    previous_provider = get_remote_device_command_provider()
    register_remote_device_command_provider(DefaultRemoteDeviceCommandProvider())
    monkeypatch.delenv("REMOTE_DEVICE_DOCKER_IMAGE", raising=False)
    monkeypatch.delenv("REMOTE_DEVICE_BACKEND_URL", raising=False)
    monkeypatch.delenv("REMOTE_DEVICE_EXECUTOR_INSTALL_URL", raising=False)
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "")
    monkeypatch.setattr(settings, "WEGENT_SOCKET_URL", "")
    yield
    register_remote_device_command_provider(previous_provider)


@pytest.mark.asyncio
async def test_create_docker_start_command_creates_credentials_without_device_crd(
    monkeypatch,
    test_db,
    test_user,
):
    monkeypatch.setattr(
        settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://backend.current.example",
    )
    monkeypatch.setattr(
        settings,
        "BACKEND_INTERNAL_URL",
        "http://backend:8000",
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
    assert response.env["EXECUTOR_MODE"] == "local"
    assert response.env["WEGENT_EXECUTOR_HOME_ID"] == response.device_id
    assert response.env["WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED"] == "true"
    assert response.env["WEGENT_BACKEND_URL"] == "https://backend.current.example"
    assert response.env["DEVICE_PUBLIC_BASE_URL"] == "http://localhost:17888"
    assert response.image == "ghcr.io/wecode-ai/wegent-device:latest"
    assert "-p 17888:17888" in response.command
    assert "--network host" not in response.command
    assert [command.kind for command in response.commands] == ["docker", "process"]
    assert response.commands[0].command == response.command
    assert "local_executor_install.sh" in response.commands[1].command
    assert (
        "DEVICE_PUBLIC_BASE_URL=http://localhost:17888" in response.commands[1].command
    )
    assert (
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true"
        in response.commands[0].command
    )
    assert (
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED"
        not in response.commands[1].command
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
    monkeypatch.setattr(
        remote_devices,
        "create_api_key_for_remote_device",
        lambda db, user_id, user_name: ("key-id", "wg-remote-token"),
    )
    monkeypatch.setenv(
        "REMOTE_DEVICE_BACKEND_URL",
        "https://backend.example.com/api",
    )
    monkeypatch.setattr(
        settings,
        "WEGENT_SOCKET_URL",
        "wss://socket.example.com",
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
    assert response.env["WEGENT_SOCKET_URL"] == "wss://socket.example.com"
    assert response.env["DEVICE_PUBLIC_BASE_URL"] == "http://app.example.com:17888"
    assert "--add-host host.docker.internal:host-gateway" not in response.command


@pytest.mark.asyncio
async def test_create_docker_start_command_keeps_client_origin_optional(
    monkeypatch,
    test_db,
    test_user,
):
    response = await remote_devices.create_docker_start_command(
        request=_FakeRequest(host="backend.example.com", scheme="https"),
        body=remote_devices.CreateDockerRemoteDeviceRequest(),
        db=test_db,
        current_user=test_user,
    )

    assert response.env["WEGENT_BACKEND_URL"] == "https://backend.example.com"
    assert response.env["WEGENT_SOCKET_URL"] == "https://backend.example.com"
    assert response.env["DEVICE_PUBLIC_BASE_URL"] == "http://backend.example.com:17888"


def _provider_context(
    container_name: str = "remote device",
) -> RemoteDeviceCommandContext:
    return RemoteDeviceCommandContext(
        container_name=container_name,
        client_origin="https://app.example.com",
        request_scheme="https",
        request_netloc="backend.example.com",
        request_headers={"host": "backend.example.com"},
        device_id="device-1",
        device_name="alice-remote-device-1",
        auth_token="wg-secret-token",
    )


def test_default_provider_rejects_invalid_backend_url(monkeypatch):
    monkeypatch.setenv("REMOTE_DEVICE_BACKEND_URL", "https://user:secret@example.com")

    with pytest.raises(HTTPException) as exc_info:
        DefaultRemoteDeviceCommandProvider().build(_provider_context())

    assert exc_info.value.status_code == 400
    assert "must not contain user information" in exc_info.value.detail


def test_default_provider_rejects_invalid_image(monkeypatch):
    monkeypatch.setenv(
        "REMOTE_DEVICE_DOCKER_IMAGE", "ghcr.io/example/device:latest\n--privileged"
    )

    with pytest.raises(HTTPException) as exc_info:
        DefaultRemoteDeviceCommandProvider().build(_provider_context())

    assert exc_info.value.status_code == 400


def test_default_provider_shell_quotes_container_name(monkeypatch):
    monkeypatch.setenv("REMOTE_DEVICE_BACKEND_URL", "https://backend.example.com")

    result = DefaultRemoteDeviceCommandProvider().build(
        _provider_context("remote device; echo unsafe")
    )

    assert "--name 'remote device; echo unsafe'" in result.command
