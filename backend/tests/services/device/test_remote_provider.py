# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for remote device provider behavior."""

from datetime import datetime

import pytest

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device.provider_factory import DeviceProviderFactory
from app.services.device_service import device_service


@pytest.mark.asyncio
async def test_device_service_lists_remote_devices(test_db, test_user):
    """Remote devices should be returned by the provider aggregation."""
    device_json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Device",
        "metadata": {"name": "remote-device-1", "namespace": "default"},
        "spec": {
            "deviceId": "remote-device-1",
            "displayName": "Docker Remote Device",
            "deviceType": DeviceType.REMOTE.value,
            "connectionMode": "websocket",
            "bindShell": "claudecode",
            "isDefault": False,
            "remoteConfig": {
                "provider": "docker",
                "image": "ghcr.io/wecode-ai/wegent-device:latest",
                "deviceId": "remote-device-1",
                "deviceName": "Docker Remote Device",
                "createdAt": datetime.now().isoformat(),
            },
        },
        "status": {"state": "Available"},
    }
    test_db.add(
        Kind(
            user_id=test_user.id,
            kind="Device",
            name="remote-device-1",
            namespace="default",
            json=device_json,
        )
    )
    test_db.commit()

    assert DeviceProviderFactory.get_provider(DeviceType.REMOTE) is not None

    devices = await device_service.get_all_devices(test_db, test_user.id)

    assert [device["device_id"] for device in devices] == ["remote-device-1"]
    assert devices[0]["device_type"] == DeviceType.REMOTE.value
    assert devices[0]["remote_config"]["provider"] == "docker"
