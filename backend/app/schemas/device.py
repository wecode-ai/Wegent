# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device schemas for request/response validation.
"""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field

from shared.models.db.enums import DeviceStatus


class DeviceInfo(BaseModel):
    """Response schema for device information."""

    device_id: str = Field(..., description="Device unique identifier")
    name: str = Field(..., description="Device name")
    status: DeviceStatus = Field(..., description="Device status")
    last_heartbeat: Optional[datetime] = Field(
        None, description="Last heartbeat timestamp"
    )

    class Config:
        from_attributes = True


class DeviceListResponse(BaseModel):
    """Response schema for listing online devices."""

    items: List[DeviceInfo]
    total: int


class DeviceRegisterPayload(BaseModel):
    """Payload for device registration via WebSocket."""

    device_id: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Device unique identifier (self-generated)",
    )
    name: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Device name (self-provided)",
    )


class DeviceHeartbeatPayload(BaseModel):
    """Payload for device heartbeat via WebSocket."""

    device_id: str = Field(..., description="Device unique identifier")


class DeviceStatusPayload(BaseModel):
    """Payload for device status update via WebSocket."""

    device_id: str = Field(..., description="Device unique identifier")
    status: DeviceStatus = Field(..., description="New device status")


class DeviceOnlineEvent(BaseModel):
    """Event payload for device coming online."""

    device_id: str
    name: str
    status: DeviceStatus = DeviceStatus.ONLINE


class DeviceOfflineEvent(BaseModel):
    """Event payload for device going offline."""

    device_id: str


class DeviceStatusEvent(BaseModel):
    """Event payload for device status change."""

    device_id: str
    status: DeviceStatus
