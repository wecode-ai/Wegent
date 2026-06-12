# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal cloud device fields exposed through device responses."""

from app.schemas.device import DeviceInfo


def test_device_info_preserves_internal_cloud_config_fields():
    """Cloud device responses should pass through wecode-owned cloud config fields."""
    device = DeviceInfo(
        id=1,
        device_id="device-1",
        name="cloud-device",
        status="offline",
        device_type="cloud",
        bind_shell="claudecode",
        cloud_config={
            "sandboxId": "sandbox-1",
            "imageId": "image-1",
            "deviceId": "runtime-device-1",
            "deviceName": "cloud-device",
            "ubuntuInitialPassword": "initial-password",
        },
    )

    assert device.cloud_config["ubuntuInitialPassword"] == "initial-password"
    assert device.cloud_config["deviceId"] == "runtime-device-1"
