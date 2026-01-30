# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device API endpoints for querying and managing user's local devices.

Devices are stored as Device CRD in the kinds table.
Online status is managed via Redis with heartbeat mechanism.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.device import DeviceInfo, DeviceListResponse
from app.services.device_service import device_service

router = APIRouter()


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
