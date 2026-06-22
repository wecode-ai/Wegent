# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Register the internal admin cloud device restart implementation."""

import logging

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

try:
    from app.services.device.admin_device_restart import (
        AdminDeviceRestartResult,
        register_admin_device_restart_handler,
    )
    from app.services.device_service import DeviceService as device_service
    from wecode.service.cloud_device_provider import cloud_device_provider
    from wecode.service.nevis_client import NevisClientError
except Exception:
    register_admin_device_restart_handler = None  # type: ignore


async def restart_device_patched(
    db: Session,
    user_id: int,
    device_id: str,
) -> "AdminDeviceRestartResult":
    """Restart a cloud device via Nevis Sandbox API."""
    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device not found: device_id={device_id}, user_id={user_id}",
        )

    try:
        restart_result = await cloud_device_provider.restart_device(
            db=db,
            user_id=user_id,
            device_id=device_id,
        )
        sandbox_id = restart_result["sandbox_id"]
        logger.info(
            f"[Admin Device Restart] Success: "
            f"user_id={user_id}, device_id={device_id}, sandbox_id={sandbox_id}"
        )
        return AdminDeviceRestartResult(
            success=True,
            message="Restart command sent successfully",
        )
    except NevisClientError as e:
        logger.error(
            f"[Admin Device Restart] Failed: device_id={device_id}, error={str(e)}"
        )
        raise HTTPException(
            status_code=e.status_code or status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


def apply_patch() -> None:
    """Register the internal admin restart handler."""
    if register_admin_device_restart_handler is None:
        logger.warning("[wecode] admin device restart registry unavailable")
        return

    register_admin_device_restart_handler(restart_device_patched)
    logger.info("[wecode] Registered admin device restart handler")


# Auto-register on import
apply_patch()
