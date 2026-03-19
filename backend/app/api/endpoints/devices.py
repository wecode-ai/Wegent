# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device API endpoints for querying and managing user's local devices.

Devices are stored as Device CRD in the kinds table.
Online status is managed via Redis with heartbeat mechanism.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.device import DeviceInfo, DeviceListResponse
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

router = APIRouter()


# ==================== Request/Response Schemas for Upgrade ====================


class DeviceUpgradeRequest(BaseModel):
    """Request model for triggering a device upgrade."""

    force: bool = Field(
        default=False, description="Force upgrade even if already on latest version"
    )
    auto_confirm: bool = Field(
        default=True, description="Skip user confirmation prompts"
    )
    verbose: bool = Field(
        default=False, description="Enable verbose logging during upgrade"
    )
    force_stop_tasks: bool = Field(
        default=False,
        description="Cancel running tasks before upgrade (default: reject if tasks running)",
    )
    registry: Optional[str] = Field(
        default=None, description="Optional: Override registry URL for update source"
    )
    registry_token: Optional[str] = Field(
        default=None, description="Optional: Auth token for private registry"
    )


class DeviceUpgradeResponse(BaseModel):
    """Response model for device upgrade trigger."""

    success: bool = Field(..., description="Whether the upgrade command was sent")
    message: str = Field(..., description="Human-readable status message")


@router.get("", response_model=DeviceListResponse)
async def get_all_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all devices for the current user (including offline).

    Returns all registered devices with their current online status.
    Devices auto-register via WebSocket when they connect.

    Returns:
        DeviceListResponse with all devices list
    """
    devices = await device_service.get_all_devices(db, current_user.id)
    return DeviceListResponse(
        items=[DeviceInfo(**d) for d in devices],
        total=len(devices),
    )


@router.get("/online", response_model=DeviceListResponse)
async def get_online_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get only online devices for the current user.

    Queries Redis for online device status and returns the list.
    This endpoint is for backward compatibility.

    Returns:
        DeviceListResponse with online devices list
    """
    devices = await device_service.get_online_devices(db, current_user.id)
    return DeviceListResponse(
        items=[DeviceInfo(**d) for d in devices],
        total=len(devices),
    )


@router.put("/{device_id}/default")
async def set_default_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Set a device as the default executor.

    Only one device can be default at a time.
    Setting a new default will clear the previous default.

    Args:
        device_id: Device unique identifier

    Returns:
        Success message

    Raises:
        HTTPException 404: If device not found
    """
    success = device_service.set_device_as_default(db, current_user.id, device_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device '{device_id}' not found",
        )
    return {"message": f"Device '{device_id}' set as default"}


@router.delete("/{device_id}")
async def delete_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a device registration.

    Note: If the device reconnects via WebSocket, it will be re-registered.

    Args:
        device_id: Device unique identifier

    Returns:
        Success message

    Raises:
        HTTPException 404: If device not found
    """
    success = device_service.delete_device(db, current_user.id, device_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device '{device_id}' not found",
        )
    return {"message": f"Device '{device_id}' deleted"}


@router.post("/{device_id}/upgrade", response_model=DeviceUpgradeResponse)
async def trigger_device_upgrade(
    device_id: str,
    request: DeviceUpgradeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DeviceUpgradeResponse:
    """
    Trigger a remote upgrade for a device.

    This endpoint sends an upgrade command to the specified device via WebSocket.
    The device must be online and owned by the current user.

    Args:
        device_id: The unique device identifier
        request: Upgrade configuration options
        db: Database session
        current_user: Authenticated user

    Returns:
        DeviceUpgradeResponse indicating success/failure

    Raises:
        HTTPException 404: If device not found or access denied
        HTTPException 400: If device is offline or has running tasks
    """
    user_id = current_user.id

    # Check if device exists and user owns it
    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        logger.warning(
            f"[Device Upgrade] Device not found or access denied: "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found or access denied",
        )

    # Get device status from provider (includes Redis online status and running tasks)
    from app.schemas.device import DeviceType
    from app.services.device.provider_factory import DeviceProviderFactory

    device_type_str = device_kind.json.get("spec", {}).get(
        "deviceType", DeviceType.LOCAL.value
    )
    device_type = DeviceType(device_type_str)
    provider = DeviceProviderFactory.get_provider(device_type)
    if provider is None:
        logger.error(
            f"[Device Upgrade] No provider found for device type: {device_type}, "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"No provider available for device type: {device_type}",
        )
    device_info = await provider.get_status(db, user_id, device_id)

    # Check if device is online
    if device_info.get("status") != "online":
        logger.warning(
            f"[Device Upgrade] Device is offline: "
            f"user_id={user_id}, device_id={device_id}, status={device_info.get('status')}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Device is offline"
        )

    # Check if device has running tasks
    running_tasks = device_info.get("running_tasks", [])
    if running_tasks and not request.force_stop_tasks:
        logger.warning(
            f"[Device Upgrade] Device has {len(running_tasks)} running tasks: "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Device has {len(running_tasks)} running task(s). "
            f"Wait for tasks to complete or use force_stop_tasks=true",
        )

    # Get socket_id from Redis
    online_info = await device_service.get_device_online_info(user_id, device_id)
    if not online_info:
        logger.error(
            f"[Device Upgrade] Device online info not found in Redis: "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device online information not found",
        )

    socket_id = online_info.get("socket_id")
    if not socket_id:
        logger.error(
            f"[Device Upgrade] Device socket_id not found: "
            f"user_id={user_id}, device_id={device_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device socket information not found",
        )

    # Emit upgrade command via WebSocket
    try:
        from app.api.ws.device_namespace import device_namespace

        upgrade_params = {
            "force": request.force,
            "auto_confirm": request.auto_confirm,
            "verbose": request.verbose,
            "force_stop_tasks": request.force_stop_tasks,
            "registry": request.registry,
            "registry_token": request.registry_token,
        }

        success = await device_namespace.emit_upgrade_command(socket_id, upgrade_params)

        if success:
            logger.info(
                f"[Device Upgrade] Upgrade command sent: "
                f"user_id={user_id}, device_id={device_id}, socket_id={socket_id}"
            )
            return DeviceUpgradeResponse(
                success=True, message="Upgrade command sent to device"
            )
        else:
            logger.error(
                f"[Device Upgrade] Failed to emit upgrade command: "
                f"user_id={user_id}, device_id={device_id}"
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to send upgrade command to device",
            )

    except Exception as e:
        logger.exception(
            f"[Device Upgrade] Error triggering upgrade: "
            f"user_id={user_id}, device_id={device_id}, error={e}"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to trigger upgrade: {str(e)}",
        )
