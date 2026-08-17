# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the internal remote device startup policy."""

import logging
import tomllib
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.endpoints import remote_devices
from app.core.config import settings
from app.models.kind import Kind
from app.services.device.remote_device_startup import (
    RemoteDeviceCommandContext,
    get_remote_device_command_provider,
    register_remote_device_command_provider,
)
from wecode.config.remote_device_config import (
    RemoteDeviceSettings,
    remote_device_settings,
)
from wecode.service.remote_device_startup_provider import (
    WecodeRemoteDeviceCommandProvider,
    _validate_image,
)


class _FakeRequest:
    headers = {"host": "backend.example.com"}
    url = SimpleNamespace(scheme="https", netloc="backend.example.com")


def _context() -> RemoteDeviceCommandContext:
    return RemoteDeviceCommandContext(
        container_name="remote device",
        client_origin=None,
        request_scheme="https",
        request_netloc="backend.example.com",
        request_headers={"host": "backend.example.com"},
        device_id="device-1",
        device_name="alice-remote-device-1",
        auth_token="wg-secret-token",
    )


def test_internal_provider_generates_pinned_host_network_commands(monkeypatch):
    monkeypatch.setattr(
        settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://backend.example.com/api",
    )
    monkeypatch.setattr(
        settings,
        "WEGENT_SOCKET_URL",
        "wss://socket.example.com/",
    )
    config = RemoteDeviceSettings(
        REMOTE_DEVICE_DOCKER_IMAGE=("registry.api.weibo.com/ci/wegent-device:1.8.6")
    )

    result = WecodeRemoteDeviceCommandProvider(config).build(_context())

    assert result.image == "registry.api.weibo.com/ci/wegent-device:1.8.6"
    assert result.env["WEGENT_BACKEND_URL"] == "https://backend.example.com"
    assert result.env["WEGENT_SOCKET_URL"] == "wss://socket.example.com"
    assert result.env["DEVICE_SESSION_GATEWAY_HOST"] == "0.0.0.0"
    assert "--network host" in result.command
    assert "--pull always" in result.command
    assert "-p 17888:17888" not in result.command
    assert "--name 'remote device'" in result.command
    assert result.command.rstrip().endswith(result.image)
    assert 'if [ -z "${DEVICE_PUBLIC_BASE_URL:-}" ]; then' in result.commands[1].command


@pytest.mark.parametrize(
    "image",
    [
        "",
        "ghcr.io/wecode-ai/wegent-device:1.8.6",
        "registry.api.weibo.com/ci/wegent-device:latest",
        "registry.api.weibo.com/ci/wegent-device",
        "registry.api.weibo.com/ci/wegent-device:<version>",
    ],
)
def test_internal_provider_rejects_unpinned_or_external_images(image):
    with pytest.raises(HTTPException) as exc_info:
        _validate_image(image)

    assert exc_info.value.status_code == 400


def test_internal_provider_rejects_socket_url_with_credentials(monkeypatch):
    monkeypatch.setattr(
        settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://backend.example.com",
    )
    monkeypatch.setattr(
        settings,
        "WEGENT_SOCKET_URL",
        "wss://user:password@socket.example.com",
    )

    with pytest.raises(HTTPException) as exc_info:
        WecodeRemoteDeviceCommandProvider(remote_device_settings).build(_context())

    assert exc_info.value.status_code == 400
    assert "must not contain user information" in exc_info.value.detail


@pytest.mark.asyncio
async def test_internal_route_creates_credentials_without_logging_token(
    monkeypatch,
    caplog,
    test_db,
    test_user,
):
    monkeypatch.setattr(
        settings,
        "WEGENT_BACKEND_PUBLIC_URL",
        "https://backend.example.com/api",
    )
    monkeypatch.setattr(
        settings,
        "WEGENT_SOCKET_URL",
        "wss://socket.example.com",
    )
    previous_provider = get_remote_device_command_provider()
    register_remote_device_command_provider(
        WecodeRemoteDeviceCommandProvider(remote_device_settings)
    )
    caplog.set_level(logging.INFO)
    try:
        response = await remote_devices.create_docker_start_command(
            request=_FakeRequest(),
            body=remote_devices.CreateDockerRemoteDeviceRequest(),
            db=test_db,
            current_user=test_user,
        )
    finally:
        register_remote_device_command_provider(previous_provider)

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
    assert response.env["WEGENT_AUTH_TOKEN"] not in caplog.text


def test_internal_default_image_tag_matches_executor_version():
    cargo_manifest = tomllib.loads(
        Path("../executor/Cargo.toml").read_text(encoding="utf-8")
    )

    assert remote_device_settings.REMOTE_DEVICE_DOCKER_IMAGE.endswith(
        f":{cargo_manifest['package']['version']}"
    )
