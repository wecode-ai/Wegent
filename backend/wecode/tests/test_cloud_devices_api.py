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
