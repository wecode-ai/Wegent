# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device API endpoints for querying user's local devices.

Note: This module only provides read-only APIs.
Device management (register, delete) is handled via WebSocket.
"""

from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.device import DeviceInfo, DeviceListResponse
from app.services.device_service import device_service

router = APIRouter()


@router.get("/online", response_model=DeviceListResponse)
async def get_online_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get current user's online devices.

    Queries Redis for online device status and returns the list.
    Devices auto-register via WebSocket when they connect.

    Returns:
        DeviceListResponse with online devices list
    """
    devices = await device_service.get_online_devices(db, current_user.id)
    return DeviceListResponse(
        items=[DeviceInfo(**d) for d in devices],
        total=len(devices),
    )
