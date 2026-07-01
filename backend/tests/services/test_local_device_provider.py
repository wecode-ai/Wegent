# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local device provider filtering."""

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device.local_provider import AppDeviceProvider, LocalDeviceProvider


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


async def test_app_provider_lists_app_devices_separately(test_db):
    """Desktop app registrations keep their explicit app device type."""
    test_db.add(_local_device("app-device", DeviceType.APP.value))
    test_db.add(_local_device("local-device", DeviceType.LOCAL.value))
    test_db.commit()

    app_devices = await AppDeviceProvider().list_devices(test_db, user_id=7)
    local_devices = await LocalDeviceProvider().list_devices(test_db, user_id=7)

    assert [device["device_id"] for device in app_devices] == ["app-device"]
    assert app_devices[0]["device_type"] == DeviceType.APP.value
    assert [device["device_id"] for device in local_devices] == ["local-device"]
