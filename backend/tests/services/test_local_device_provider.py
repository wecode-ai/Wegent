# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local device provider filtering."""

from app.models.kind import Kind
from app.schemas.device import DeviceType
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


async def test_list_devices_excludes_remote_devices(test_db):
    """Remote devices are listed by RemoteDeviceProvider, not LocalDeviceProvider."""
    test_db.add(_local_device("remote-device", DeviceType.REMOTE.value))
    test_db.commit()

    devices = await LocalDeviceProvider().list_devices(test_db, user_id=7)

    assert devices == []
