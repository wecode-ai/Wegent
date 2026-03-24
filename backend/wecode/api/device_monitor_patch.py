# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Monkey-patch app.api.endpoints.admin.device_monitor.restart_device
to implement actual cloud device restart via Nevis Sandbox API.

This replaces the stub implementation with real Nevis API calls.

Auto-applied on import.
"""

import logging
from functools import wraps
from typing import Callable

from fastapi import HTTPException, status

logger = logging.getLogger(__name__)

try:
    from app.api.endpoints.admin import device_monitor as device_monitor_module
    from app.schemas.device import DeviceType
    from app.services.device_service import DeviceService as device_service
    from wecode.service.nevis_client import NevisClientError, nevis_client
except Exception:
    device_monitor_module = None  # type: ignore


def _create_restart_implementation(original_endpoint: Callable) -> Callable:
    """Create the actual restart implementation that calls Nevis API."""

    @wraps(original_endpoint)
    async def restart_device_impl(device_id, request, db, current_user):
        """Restart a cloud device via Nevis Sandbox API (admin only).

        Args:
            device_id: Device unique identifier
            request: Restart request with user_id
            db: Database session
            current_user: Must be admin

        Returns:
            AdminDeviceActionResponse indicating success/failure
        """
        user_id = request.user_id

        # 1. Validate device exists
        device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
        if not device_kind:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Device not found: device_id={device_id}, user_id={user_id}",
            )

        # 2. Check device type - only cloud devices can be restarted
        spec = device_kind.json.get("spec", {}) if device_kind.json else {}
        device_type = spec.get("deviceType", DeviceType.LOCAL.value)
        if device_type != DeviceType.CLOUD.value:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only cloud devices can be restarted",
            )

        # 3. Get sandbox_id from cloudConfig
        cloud_config = spec.get("cloudConfig", {})
        sandbox_id = cloud_config.get("sandboxId")
        if not sandbox_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cloud device missing sandbox ID",
            )

        # 4. Call Nevis API to restart sandbox
        try:
            await nevis_client.restart_sandbox(sandbox_id)
            logger.info(
                f"[Admin Device Restart] Success: "
                f"admin={current_user.user_name}, user_id={user_id}, "
                f"device_id={device_id}, sandbox_id={sandbox_id}"
            )
            return device_monitor_module.AdminDeviceActionResponse(
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

    setattr(restart_device_impl, "_wecode_patched", True)
    return restart_device_impl


def apply_patch() -> None:
    """Replace restart_device endpoint with actual Nevis implementation."""
    if device_monitor_module is None:
        return

    router = getattr(device_monitor_module, "router", None)
    if router is None or not hasattr(router, "routes"):
        return

    for route in router.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", set())
        endpoint = getattr(route, "endpoint", None)

        # Find the restart endpoint
        if path == "/devices/{device_id}/restart" and "POST" in methods:
            if callable(endpoint) and not getattr(endpoint, "_wecode_patched", False):
                route.endpoint = _create_restart_implementation(endpoint)
                logger.info(
                    "[wecode] Patched restart_device endpoint with Nevis implementation"
                )
                break


# Auto-apply on import
apply_patch()
