# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud device API behavior."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks

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

    async def get_status(self, **kwargs):
        return {
            "device_id": kwargs["device_id"],
            "cloud_config": {"sandboxId": "sandbox-1"},
        }

    async def get_vm_status(self, sandbox_id):
        return {
            "sandbox_id": sandbox_id,
            "status": "running",
            "ip_address": "2001:0db8:0:0::5",
        }


@pytest.mark.asyncio
async def test_create_cloud_device_passes_current_user_jwt_to_provider(monkeypatch):
    """Cloud device creation should pass the request JWT into user_data."""
    provider = _FakeCloudDeviceProvider()
    background_tasks = BackgroundTasks()
    monkeypatch.setattr(cloud_devices, "cloud_device_provider", provider)
    monkeypatch.setattr(
        "wecode.service.api_key_service.create_api_key_for_cloud_device",
        lambda db, user_id, user_name: ("key-id", "device-api-key"),
    )

    await cloud_devices.create_cloud_device(
        request=_FakeRequest(),
        background_tasks=background_tasks,
        body=CreateCloudDeviceRequest(),
        db=SimpleNamespace(),
        current_user=SimpleNamespace(id=7, user_name="alice"),
    )

    assert provider.create_device_kwargs["auth_token"] == "device-api-key"
    assert provider.create_device_kwargs["user_jwt_token"] == "jwt.current.user"
    assert "git_tokens" not in provider.create_device_kwargs
    assert len(background_tasks.tasks) == 1
    assert background_tasks.tasks[0].func == (
        cloud_devices.cloud_device_ip_index_service.sync_device
    )
    assert background_tasks.tasks[0].args == (7, "device-1")


@pytest.mark.asyncio
async def test_restart_cloud_device_uses_current_user(monkeypatch):
    """Cloud device restart should be scoped to the current user."""
    provider = _FakeCloudDeviceProvider()
    db = SimpleNamespace()
    background_tasks = BackgroundTasks()
    monkeypatch.setattr(cloud_devices, "cloud_device_provider", provider)

    response = await cloud_devices.restart_cloud_device(
        device_id="device-1",
        background_tasks=background_tasks,
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
    assert len(background_tasks.tasks) == 1
    assert background_tasks.tasks[0].func == (
        cloud_devices.cloud_device_ip_index_service.sync_device
    )
    assert background_tasks.tasks[0].args == (7, "device-1")


@pytest.mark.asyncio
async def test_get_cloud_device_status_persists_nevis_ip(monkeypatch):
    provider = _FakeCloudDeviceProvider()
    db = MagicMock()
    persist_observation = MagicMock(return_value=True)
    monkeypatch.setattr(cloud_devices, "cloud_device_provider", provider)
    monkeypatch.setattr(
        cloud_devices.cloud_device_ip_index_service,
        "persist_observation",
        persist_observation,
    )

    response = await cloud_devices.get_cloud_device_nevis_status(
        device_id="device-1",
        user_id=None,
        db=db,
        current_user=SimpleNamespace(id=7, user_name="alice"),
    )

    target = persist_observation.call_args.args[1]
    assert response.ip_address == "2001:0db8:0:0::5"
    assert target.user_id == 7
    assert target.device_name == "device-1"
    assert target.sandbox_id == "sandbox-1"
    assert persist_observation.call_args.args[2] == "2001:db8::5"
    db.commit.assert_called_once_with()
