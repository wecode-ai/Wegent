# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device management endpoints.

Handles device listing, status updates, and deletion for wecode-cli connections.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import case
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.device import Device
from app.models.user import User
from app.schemas.device import (
    DeviceListResponse,
    DeviceResponse,
    DeviceUpdateRequest,
)

router = APIRouter()


@router.get("", response_model=DeviceListResponse)
async def list_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get all devices for the current user."""
    # MySQL doesn't support NULLS LAST, use CASE to sort NULL values last
    devices = (
        db.query(Device)
        .filter(Device.user_id == current_user.id)
        .order_by(
            case((Device.last_seen_at.is_(None), 1), else_=0),
            Device.last_seen_at.desc(),
            Device.created_at.desc(),
        )
        .all()
    )
    return DeviceListResponse(
        items=[DeviceResponse.model_validate(device) for device in devices],
        total=len(devices),
    )


@router.get("/{device_id}", response_model=DeviceResponse)
async def get_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get a specific device by device_id."""
    device = (
        db.query(Device)
        .filter(
            Device.device_id == device_id,
            Device.user_id == current_user.id,
        )
        .first()
    )

    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found",
        )

    return DeviceResponse.model_validate(device)


@router.patch("/{device_id}", response_model=DeviceResponse)
async def update_device(
    device_id: str,
    update_request: DeviceUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Update device information (e.g., name)."""
    device = (
        db.query(Device)
        .filter(
            Device.device_id == device_id,
            Device.user_id == current_user.id,
        )
        .first()
    )

    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found",
        )

    if update_request.name is not None:
        device.name = update_request.name

    db.commit()
    db.refresh(device)

    return DeviceResponse.model_validate(device)


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Delete a device (unregister)."""
    device = (
        db.query(Device)
        .filter(
            Device.device_id == device_id,
            Device.user_id == current_user.id,
        )
        .first()
    )

    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found",
        )

    db.delete(device)
    db.commit()

    return None
