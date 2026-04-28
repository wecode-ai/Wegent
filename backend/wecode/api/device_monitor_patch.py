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

from fastapi import Depends, HTTPException, Path, status
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

try:
    from app.api.dependencies import get_db
    from app.api.endpoints.admin import device_monitor as device_monitor_module
    from app.core import security
    from app.models.user import User
    from app.schemas.device import DeviceType
    from app.services.device_service import DeviceService as device_service
    from wecode.service.cloud_device_provider import cloud_device_provider
    from wecode.service.nevis_client import NevisClientError
except Exception:
    device_monitor_module = None  # type: ignore


async def restart_device_patched(
    device_id: str = Path(..., description="Device unique identifier"),
    request: "device_monitor_module.AdminDeviceRestartRequest" = ...,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_admin_user),
):
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

    # 3. Restart the cloud device using the shared provider logic
    try:
        restart_result = await cloud_device_provider.restart_device(
            db=db,
            user_id=user_id,
            device_id=device_id,
        )
        sandbox_id = restart_result["sandbox_id"]
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


# Mark the patched function
setattr(restart_device_patched, "_wecode_patched", True)


def _patch_route_in_router(router, target_path: str, new_endpoint) -> bool:
    """Recursively find and patch a route in router and its sub-routers.

    Args:
        router: The router to search in
        target_path: The full path to match (e.g., "/admin/device-monitor/devices/{device_id}/restart")
        new_endpoint: The new endpoint function to use

    Returns:
        True if the route was found and patched
    """
    if not hasattr(router, "routes"):
        return False

    for route in router.routes:
        # Check if this is the target route
        route_path = getattr(route, "path", "")
        methods = getattr(route, "methods", set())

        if route_path == target_path and "POST" in methods:
            endpoint = getattr(route, "endpoint", None)
            if callable(endpoint) and not getattr(endpoint, "_wecode_patched", False):
                route.endpoint = new_endpoint
                logger.info(
                    f"[wecode] Patched route {target_path} with Nevis implementation"
                )
                return True

        # Check sub-router (for APIRouter.include_router cases)
        if hasattr(route, "app"):
            sub_router = route.app
            # Build the sub-path by removing the route's path prefix
            if target_path.startswith(route_path):
                sub_path = target_path[len(route_path) :]
                if _patch_route_in_router(sub_router, sub_path, new_endpoint):
                    return True

    return False


def apply_patch() -> None:
    """Replace restart_device endpoint function with actual Nevis implementation."""
    if device_monitor_module is None:
        logger.warning("[wecode] device_monitor_module not available, skipping patch")
        return

    # 1. Patch the module-level function directly
    original_func = getattr(device_monitor_module, "restart_device", None)
    if original_func is None:
        logger.warning("[wecode] restart_device function not found, skipping patch")
        return

    if getattr(original_func, "_wecode_patched", False):
        logger.debug("[wecode] restart_device already patched, skipping")
        return

    # Replace the function in the module
    device_monitor_module.restart_device = restart_device_patched
    logger.info("[wecode] Patched device_monitor_module.restart_device")

    # 2. Patch the device_monitor router's route
    dm_router = getattr(device_monitor_module, "router", None)
    if dm_router and hasattr(dm_router, "routes"):
        for route in dm_router.routes:
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", set())
            if path == "/devices/{device_id}/restart" and "POST" in methods:
                route.endpoint = restart_device_patched
                logger.info("[wecode] Patched device_monitor.router restart route")
                break


def apply_patch_to_api_router() -> None:
    """Apply patch to the main api_router after all routers are registered.

    This should be called after api_router is fully constructed.
    """
    try:
        from app.api.router import api_router
    except Exception:
        logger.warning("[wecode] api_router not available, skipping api_router patch")
        return

    # The full path in api_router after all include_router calls
    target_path = "/admin/device-monitor/devices/{device_id}/restart"

    if _patch_route_in_router(api_router, target_path, restart_device_patched):
        logger.info("[wecode] Patched restart_device in api_router")
    else:
        logger.warning(f"[wecode] Could not find route {target_path} in api_router")


# Auto-apply module-level patch on import
apply_patch()
