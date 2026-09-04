# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the server-side privileged remote-control boundary."""

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device.remote_control_policy import (
    device_kind_type,
    remote_control_is_enabled,
)


def _device(user_id: int, device_type: DeviceType) -> Kind:
    return Kind(
        user_id=user_id,
        kind="Device",
        name="logical-device",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": "logical-device", "namespace": "default"},
            "spec": {
                "deviceId": "runtime-device",
                "appDeviceId": "app-device",
                "deviceType": device_type.value,
            },
        },
    )


def test_app_device_keeps_privileged_remote_controls_disabled():
    device = _device(7, DeviceType.APP)

    assert device_kind_type(device) == DeviceType.APP
    assert remote_control_is_enabled(DeviceType.APP) is False


def test_remote_device_allows_privileged_remote_controls():
    assert remote_control_is_enabled(DeviceType.REMOTE) is True
