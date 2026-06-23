# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local device provider response normalization."""

import pytest

from app.models.kind import Kind
from app.schemas.device import DeviceInfo
from app.services.device.local_provider import LocalDeviceProvider


def _local_device(device_id: str, device_type: str) -> Kind:
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
                "deviceType": device_type,
                "connectionMode": "websocket",
                "bindShell": "claudecode",
                "displayName": device_id,
                "isDefault": False,
            },
        },
    )


@pytest.mark.asyncio
async def test_list_devices_normalizes_legacy_remote_device_type(
    test_db,
    monkeypatch,
):
    """Legacy remote devices are local devices in the current API contract."""
    test_db.add(_local_device("legacy-remote", "remote"))
    test_db.commit()

    async def fake_mget(keys):
        return {}

    async def fake_latest_version():
        return "1.0.0"

    monkeypatch.setattr("app.core.cache.cache_manager.mget", fake_mget)
    monkeypatch.setattr(
        "app.services.device.local_provider.executor_version_service.get_latest_version",
        fake_latest_version,
    )

    devices = await LocalDeviceProvider().list_devices(test_db, user_id=7)

    assert devices[0]["device_type"] == "local"
    DeviceInfo(**devices[0])
