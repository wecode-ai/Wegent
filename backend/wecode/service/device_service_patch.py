# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device service patch for aggregating local and cloud devices.

This patch extends DeviceService's get_all_devices and get_online_devices
methods to include cloud devices alongside local devices.

Auto-applied on import.
"""

import logging
from functools import wraps
from typing import Any, Dict, List

from sqlalchemy.orm import Session

from app.services.device_service import DeviceService

logger = logging.getLogger(__name__)

_patch_applied = False


def _wrap_get_all_devices(original_func):
    """Wrap get_all_devices to aggregate cloud devices."""

    @wraps(original_func)
    async def wrapper(db: Session, user_id: int) -> List[Dict[str, Any]]:
        # Get local devices from original implementation
        local_devices = await original_func(db, user_id)

        # Get cloud devices
        try:
            from wecode.service.cloud_device_provider import cloud_device_provider

            if cloud_device_provider.is_configured():
                cloud_devices = await cloud_device_provider.list_devices(
                    db, user_id, include_offline=True
                )
                return local_devices + cloud_devices
        except Exception as e:
            logger.warning(f"Failed to get cloud devices: {e}")

        return local_devices

    return wrapper


def _wrap_get_online_devices(original_func):
    """Wrap get_online_devices to aggregate online cloud devices."""

    @wraps(original_func)
    async def wrapper(db: Session, user_id: int) -> List[Dict[str, Any]]:
        # Get online local devices from original implementation
        local_devices = await original_func(db, user_id)

        # Get online cloud devices
        try:
            from wecode.service.cloud_device_provider import cloud_device_provider

            if cloud_device_provider.is_configured():
                cloud_devices = await cloud_device_provider.list_devices(
                    db, user_id, include_offline=False
                )
                return local_devices + cloud_devices
        except Exception as e:
            logger.warning(f"Failed to get online cloud devices: {e}")

        return local_devices

    return wrapper


def apply_patch() -> None:
    """Apply the device service patch."""
    global _patch_applied

    if _patch_applied:
        return

    try:
        # Wrap the static methods
        # Access the underlying function from staticmethod descriptor
        original_get_all = DeviceService.__dict__.get('get_all_devices')
        if isinstance(original_get_all, staticmethod):
            original_get_all = original_get_all.__func__

        original_get_online = DeviceService.__dict__.get('get_online_devices')
        if isinstance(original_get_online, staticmethod):
            original_get_online = original_get_online.__func__

        DeviceService.get_all_devices = staticmethod(
            _wrap_get_all_devices(original_get_all)
        )
        DeviceService.get_online_devices = staticmethod(
            _wrap_get_online_devices(original_get_online)
        )

        _patch_applied = True
        logger.info(
            "[DeviceServicePatch] Successfully patched DeviceService to include cloud devices"
        )
    except Exception as e:
        logger.error(f"[DeviceServicePatch] Failed to apply patch: {e}")


# Auto-apply on import
apply_patch()
