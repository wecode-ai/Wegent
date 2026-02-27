# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local device provider registration patch.

Registers LocalDeviceProvider with DeviceProviderFactory at import time.
This allows the factory to create local device providers when requested.

Auto-applied on import.
"""

import logging

from app.schemas.device import DeviceType
from app.services.device.provider_factory import DeviceProviderFactory

logger = logging.getLogger(__name__)

_patch_applied = False


def apply_patch() -> None:
    """Register LocalDeviceProvider with the factory."""
    global _patch_applied

    if _patch_applied:
        return

    try:
        from app.services.device.local_provider import local_device_provider

        DeviceProviderFactory.register_provider(
            DeviceType.LOCAL,
            local_device_provider,
        )

        _patch_applied = True
        logger.info("[LocalDevicePatch] Successfully registered LocalDeviceProvider")
    except Exception as e:
        logger.error(f"[LocalDevicePatch] Failed to register provider: {e}")


# Auto-apply on import
apply_patch()
