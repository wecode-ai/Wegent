# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud device provider response fields."""

import pytest

from app.models.kind import Kind
from app.services.device.cloud_provider import CloudDeviceProvider


def _cloud_device(device_id: str, bind_shell: str) -> Kind:
    return Kind(
        user_id=7,
        kind="Device",
        name=device_id,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {
                "name": device_id,
                "namespace": "default",
            },
            "spec": {
                "deviceId": device_id,
                "deviceType": "cloud",
                "connectionMode": "websocket",
                "bindShell": bind_shell,
                "displayName": device_id,
                "isDefault": False,
                "cloudConfig": {
                    "sandboxId": f"sandbox-{device_id}",
                    "imageId": "image-1",
                },
            },
        },
    )


@pytest.mark.asyncio
async def test_list_devices_preserves_cloud_device_bind_shell(test_db, monkeypatch):
    """Cloud devices must expose bind_shell so clients can exclude OpenClaw."""
    test_db.add(_cloud_device("cloud-claude", "claudecode"))
    test_db.add(_cloud_device("cloud-openclaw", "openclaw"))
    test_db.commit()

    async def fake_mget(keys):
        return {}

    async def fake_latest_version():
        return "1.0.0"

    monkeypatch.setattr("app.core.cache.cache_manager.mget", fake_mget)
    monkeypatch.setattr(
        "app.services.device.cloud_provider.executor_version_service.get_latest_version",
        fake_latest_version,
    )

    devices = await CloudDeviceProvider().list_devices(test_db, user_id=7)

    bind_shell_by_id = {device["device_id"]: device["bind_shell"] for device in devices}
    assert bind_shell_by_id == {
        "cloud-claude": "claudecode",
        "cloud-openclaw": "openclaw",
    }
