# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device provider registration patch.

Registers CloudDeviceProvider with DeviceProviderFactory at import time.
This allows the factory to create cloud device providers when requested.

Auto-applied on import.
"""

import logging

from app.schemas.device import DeviceType
from app.services.device.provider_factory import DeviceProviderFactory

logger = logging.getLogger(__name__)

_patch_applied = False


def apply_patch() -> None:
    """Register CloudDeviceProvider with the factory."""
    global _patch_applied

    if _patch_applied:
        return

    try:
        from wecode.service.cloud_device_provider import cloud_device_provider

        DeviceProviderFactory.register_provider(
            DeviceType.CLOUD,
            cloud_device_provider,
        )

        _patch_applied = True
        logger.info(
            "[CloudDevicePatch] Successfully registered CloudDeviceProvider"
        )
    except Exception as e:
        logger.error(f"[CloudDevicePatch] Failed to register provider: {e}")


# Auto-apply on import
apply_patch()
