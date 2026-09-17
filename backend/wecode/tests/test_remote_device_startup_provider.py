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
    assert result.env["DEVICE_CODE_SERVER_ENABLED"] == "true"
    assert result.env["DEVICE_TERMINAL_ENABLED"] == "true"
    assert result.env["DEVICE_SESSION_GATEWAY_HOST"] == "0.0.0.0"
    assert result.env["WEGENT_EXECUTOR_HOME_ID"] == "device-1"
    assert result.env["WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED"] == "true"
    assert "--network host" in result.command
    assert "--pull always" in result.command
    assert "-p 17888:17888" not in result.command
    assert "--name 'remote device'" in result.command
    assert "-e DEVICE_CODE_SERVER_ENABLED=true" in result.command
    assert "-e DEVICE_TERMINAL_ENABLED=true" in result.command
    assert "-e WEGENT_EXECUTOR_HOME_ID=device-1" in result.command
    assert "-e WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true" in result.command
    assert result.command.rstrip().endswith(result.image)
    assert 'if [ -z "${DEVICE_PUBLIC_BASE_URL:-}" ]; then' in result.commands[1].command
    assert "WEGENT_EXECUTOR_HOME_ID" not in result.commands[1].command
    assert (
        "WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true" in result.commands[1].command
    )


def test_internal_provider_falls_back_to_request_host(monkeypatch):
    monkeypatch.delenv("REMOTE_DEVICE_BACKEND_URL", raising=False)
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "")
    monkeypatch.setattr(settings, "WEGENT_SOCKET_URL", "")
    config = RemoteDeviceSettings(
        REMOTE_DEVICE_DOCKER_IMAGE=("registry.api.weibo.com/ci/wegent-device:1.8.6")
    )

    result = WecodeRemoteDeviceCommandProvider(config).build(_context())

    assert result.env["WEGENT_BACKEND_URL"] == "https://backend.example.com"
    assert result.env["WEGENT_SOCKET_URL"] == "https://backend.example.com"


def test_internal_provider_prefers_backend_url_env_override(monkeypatch):
    monkeypatch.setenv("REMOTE_DEVICE_BACKEND_URL", "https://internal.example.com")
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "")
    monkeypatch.setattr(settings, "WEGENT_SOCKET_URL", "")
    config = RemoteDeviceSettings(
        REMOTE_DEVICE_DOCKER_IMAGE=("registry.api.weibo.com/ci/wegent-device:1.8.6")
    )

    result = WecodeRemoteDeviceCommandProvider(config).build(_context())

    assert result.env["WEGENT_BACKEND_URL"] == "https://internal.example.com"


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


def test_internal_default_image_tag_matches_executor_version(monkeypatch):
    monkeypatch.delenv("REMOTE_DEVICE_DOCKER_IMAGE", raising=False)
    monkeypatch.delenv("REMOTE_DEVICE_DOCKER_IMAGE_VERSION", raising=False)
    config = RemoteDeviceSettings()

    cargo_manifest = tomllib.loads(
        Path("../executor/Cargo.toml").read_text(encoding="utf-8")
    )

    assert config.REMOTE_DEVICE_DOCKER_IMAGE.endswith(
        f":{cargo_manifest['package']['version']}"
    )


def test_internal_default_image_uses_remote_device_version_env(monkeypatch):
    monkeypatch.setenv("REMOTE_DEVICE_DOCKER_IMAGE_VERSION", "9.9.9")
    monkeypatch.delenv("REMOTE_DEVICE_DOCKER_IMAGE", raising=False)

    config = RemoteDeviceSettings()

    assert config.REMOTE_DEVICE_DOCKER_IMAGE == (
        "registry.api.weibo.com/ci/wegent-device:9.9.9"
    )


def test_internal_default_image_uses_remote_device_version_dotenv(
    monkeypatch, tmp_path
):
    monkeypatch.delenv("REMOTE_DEVICE_DOCKER_IMAGE", raising=False)
    monkeypatch.delenv("REMOTE_DEVICE_DOCKER_IMAGE_VERSION", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text(
        'REMOTE_DEVICE_DOCKER_IMAGE_VERSION="1.0.237-feature-device-tag"\n',
        encoding="utf-8",
    )

    config = RemoteDeviceSettings(_env_file=env_file)

    assert config.REMOTE_DEVICE_DOCKER_IMAGE == (
        "registry.api.weibo.com/ci/wegent-device:" "1.0.237-feature-device-tag"
    )


def test_internal_default_image_prefers_explicit_image_over_version_env(monkeypatch):
    monkeypatch.setenv(
        "REMOTE_DEVICE_DOCKER_IMAGE", "registry.api.weibo.com/ci/wegent-device:2.0.0"
    )
    monkeypatch.setenv("REMOTE_DEVICE_DOCKER_IMAGE_VERSION", "9.9.9")

    config = RemoteDeviceSettings()

    assert config.REMOTE_DEVICE_DOCKER_IMAGE == (
        "registry.api.weibo.com/ci/wegent-device:2.0.0"
    )
