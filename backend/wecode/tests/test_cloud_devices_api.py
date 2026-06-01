# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud device API behavior."""

from types import SimpleNamespace

import pytest

from wecode.api import cloud_devices
from wecode.schemas.cloud_device import CreateCloudDeviceRequest


class _FakeRequest:
    headers = {"host": "testserver", "authorization": "Bearer jwt.current.user"}
    url = SimpleNamespace(scheme="http", netloc="testserver")


class _FakeCloudDeviceProvider:
    def __init__(self):
        self.create_device_kwargs = None
        self.restart_device_kwargs = None

    def is_configured(self):
        return True

    async def create_device(self, **kwargs):
        self.create_device_kwargs = kwargs
        return {
            "id": 1,
            "device_id": "device-1",
            "name": "alice-executor",
            "status": "offline",
            "device_type": "cloud",
            "message": "created",
        }

    async def restart_device(self, **kwargs):
        self.restart_device_kwargs = kwargs
        return {
            "device_id": kwargs["device_id"],
            "sandbox_id": "sandbox-1",
            "result": {"status": "accepted"},
        }


@pytest.mark.asyncio
async def test_create_cloud_device_passes_current_user_jwt_to_provider(monkeypatch):
    """Cloud device creation should pass the request JWT into user_data."""
    provider = _FakeCloudDeviceProvider()
    monkeypatch.setattr(cloud_devices, "cloud_device_provider", provider)
    monkeypatch.setattr(
        "wecode.service.api_key_service.create_api_key_for_cloud_device",
        lambda db, user_id, user_name: ("key-id", "device-api-key"),
    )

    await cloud_devices.create_cloud_device(
        request=_FakeRequest(),
        body=CreateCloudDeviceRequest(),
        db=SimpleNamespace(),
        current_user=SimpleNamespace(id=7, user_name="alice"),
    )

    assert provider.create_device_kwargs["auth_token"] == "device-api-key"
    assert provider.create_device_kwargs["user_jwt_token"] == "jwt.current.user"


@pytest.mark.asyncio
async def test_restart_cloud_device_uses_current_user(monkeypatch):
    """Cloud device restart should be scoped to the current user."""
    provider = _FakeCloudDeviceProvider()
    db = SimpleNamespace()
    monkeypatch.setattr(cloud_devices, "cloud_device_provider", provider)

    response = await cloud_devices.restart_cloud_device(
        device_id="device-1",
        db=db,
        current_user=SimpleNamespace(id=7, user_name="alice"),
    )

    assert response["message"] == "Restart command sent successfully"
    assert response["sandbox_id"] == "sandbox-1"
    assert provider.restart_device_kwargs == {
        "db": db,
        "user_id": 7,
        "device_id": "device-1",
    }
