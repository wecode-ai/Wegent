# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device schema definitions.

Defines Pydantic models for cloud device API requests and responses.
"""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class CloudDeviceConfig(BaseModel):
    """Cloud device configuration stored in Device CRD spec.

    This configuration is stored in the Device CRD's spec.cloudConfig field
    and contains Nevis-specific information about the cloud device.
    """

    sandboxId: str = Field(..., description="Nevis sandbox ID")
    imageId: str = Field(..., description="Image ID used for VM creation")
    createdAt: datetime = Field(
        default_factory=datetime.now,
        description="Cloud device creation timestamp",
    )


class CloudDeviceResponse(BaseModel):
    """Response schema for cloud device creation.

    Returned after successfully creating a cloud device via Nevis API.
    """

    id: int = Field(..., description="Device CRD ID in database")
    device_id: str = Field(..., description="Device unique identifier (sandbox ID)")
    name: str = Field(..., description="Device display name")
    status: str = Field(
        default="offline",
        description="Device status (offline until executor connects)",
    )
    device_type: str = Field(default="cloud", description="Device type")
    message: str = Field(..., description="Status message")

    class Config:
        from_attributes = True


class NevisSandboxStatus(BaseModel):
    """Nevis sandbox status information.

    Returned when querying cloud device status from Nevis API.
    """

    sandbox_id: str = Field(..., description="Nevis sandbox ID")
    status: str = Field(
        ...,
        description="Sandbox status (creating, running, stopped, error)",
    )
    ip_address: Optional[str] = Field(None, description="VM IP address if assigned")
    created_at: Optional[datetime] = Field(
        None,
        description="Sandbox creation timestamp",
    )

    class Config:
        from_attributes = True


class CloudDeviceLimitError(BaseModel):
    """Error response when cloud device limit is reached."""

    detail: str = Field(..., description="Error message")
    max_devices: int = Field(..., description="Maximum allowed cloud devices")
    current_count: int = Field(..., description="Current cloud device count")
