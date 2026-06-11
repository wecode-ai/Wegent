# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for device API response schemas."""

from app.schemas.device import CloudConfig


def test_cloud_config_preserves_cloud_device_initial_password():
    """Cloud device list responses should include the initial ubuntu password."""
    config = CloudConfig(
        sandboxId="sandbox-1",
        imageId="image-1",
        deviceId="device-1",
        deviceName="cloud-device",
        ubuntuInitialPassword="initial-password",
    )

    assert config.ubuntuInitialPassword == "initial-password"
