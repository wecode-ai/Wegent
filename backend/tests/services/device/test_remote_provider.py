# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for remote device provider behavior."""

from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device.provider_factory import DeviceProviderFactory
from app.services.device.remote_provider import RemoteDeviceProvider
from app.services.device_service import device_service


def _remote_device(user_id: int, device_id: str = "remote-device-1") -> Kind:
    device_json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Device",
        "metadata": {"name": device_id, "namespace": "default"},
        "spec": {
            "deviceId": device_id,
            "displayName": "Docker Remote Device",
            "deviceType": DeviceType.REMOTE.value,
            "connectionMode": "websocket",
            "bindShell": "claudecode",
            "isDefault": False,
            "capabilities": ["docker"],
            "remoteConfig": {
                "provider": "docker",
                "image": "ghcr.io/wecode-ai/wegent-device:latest",
                "deviceId": device_id,
                "deviceName": "Docker Remote Device",
                "createdAt": datetime.now().isoformat(),
            },
            "runtimeTransferHost": "192.0.2.40",
            "runtimeInstanceId": "runtime-stable",
            "appDeviceId": "desktop-app-device",
        },
        "status": {"state": "Available"},
    }
    return Kind(
        user_id=user_id,
        kind="Device",
        name=device_id,
        namespace="default",
        json=device_json,
    )


@pytest.mark.asyncio
async def test_device_service_lists_remote_devices(test_db, test_user):
    """Remote devices should be returned by the provider aggregation."""
    test_db.add(_remote_device(test_user.id))
    test_db.commit()

    assert DeviceProviderFactory.get_provider(DeviceType.REMOTE) is not None

    devices = await device_service.get_all_devices(test_db, test_user.id)

    assert [device["device_id"] for device in devices] == ["remote-device-1"]
    assert devices[0]["device_type"] == DeviceType.REMOTE.value
    assert devices[0]["remote_config"]["provider"] == "docker"
    assert devices[0]["runtime_transfer_host"] == "192.0.2.40"
    assert devices[0]["socket_device_id"] == "remote-device-1"
    assert devices[0]["runtime_instance_id"] == "runtime-stable"
    assert devices[0]["app_device_id"] == "desktop-app-device"


@pytest.mark.asyncio
async def test_remote_provider_exposes_online_runtime_features(
    test_db,
    test_user,
    monkeypatch,
):
    test_db.add(_remote_device(test_user.id))
    test_db.commit()
    runtime_features = {
        "schemaVersion": 1,
        "worktrees": {"version": 1, "managed": True},
    }

    async def fake_mget(keys):
        return {
            keys[0]: {
                "socket_id": "socket-remote",
                "status": "online",
                "runtime_features": runtime_features,
            }
        }

    monkeypatch.setattr(
        "app.services.device.remote_provider.cache_manager.mget",
        fake_mget,
    )
    monkeypatch.setattr(
        "app.services.device.remote_provider.executor_version_service.get_latest_version",
        AsyncMock(return_value="1.0.0"),
    )

    devices = await RemoteDeviceProvider().list_devices(test_db, test_user.id)

    assert devices[0]["status"] == "online"
    assert devices[0]["capabilities"] == ["docker"]
    assert devices[0]["runtime_features"] == runtime_features


@pytest.mark.asyncio
async def test_remote_provider_does_not_expose_runtime_features_while_offline(
    test_db,
    test_user,
    monkeypatch,
):
    device = _remote_device(test_user.id)
    device.json["spec"]["runtimeFeatures"] = {
        "schemaVersion": 1,
        "worktrees": {"version": 1, "managed": True},
    }
    test_db.add(device)
    test_db.commit()

    monkeypatch.setattr(
        "app.services.device.remote_provider.cache_manager.mget",
        AsyncMock(return_value={}),
    )
    monkeypatch.setattr(
        "app.services.device.remote_provider.executor_version_service.get_latest_version",
        AsyncMock(return_value="1.0.0"),
    )

    devices = await RemoteDeviceProvider().list_devices(test_db, test_user.id)

    assert devices[0]["status"] == "offline"
    assert devices[0]["capabilities"] == ["docker"]
    assert devices[0]["runtime_features"] is None
