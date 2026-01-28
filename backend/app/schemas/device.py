# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device schemas for request/response validation.
"""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class DeviceResponse(BaseModel):
    """Response schema for device information."""

    id: int
    device_id: str
    name: str
    device_type: str
    status: str
    workspace_path: Optional[str] = None
    last_seen_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class DeviceListResponse(BaseModel):
    """Response schema for listing devices."""

    items: List[DeviceResponse]
    total: int


class DeviceUpdateRequest(BaseModel):
    """Request schema for updating device information."""

    name: Optional[str] = Field(None, min_length=1, max_length=128)
