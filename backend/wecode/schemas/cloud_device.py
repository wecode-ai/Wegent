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


class CreateCloudDeviceRequest(BaseModel):
    """Request schema for cloud device creation.

    Optional mail configuration is passed through to the startup script
    and is NOT stored in the database.
    """

    mail_email: Optional[str] = Field(
        None, description="Mail account username (without domain suffix)"
    )
    mail_password: Optional[str] = Field(
        None, description="Mail account password (pass-through only, not stored)"
    )


class CloudDeviceConfig(BaseModel):
    """Cloud device configuration stored in Device CRD spec.

    This configuration is stored in the Device CRD's spec.cloudConfig field
    and contains Nevis-specific information about the cloud device.
    """

    sandboxId: str = Field(..., description="Nevis sandbox ID")
    imageId: str = Field(..., description="Image ID used for VM creation")
    deviceId: Optional[str] = Field(None, description="Server-generated device UUID")
    deviceName: Optional[str] = Field(None, description="Server-generated device name")
    createdAt: datetime = Field(
        default_factory=datetime.now,
        description="Cloud device creation timestamp",
    )


class CloudDeviceResponse(BaseModel):
    """Response schema for cloud device creation.

    Returned after successfully creating a cloud device via Nevis API.
    """

    id: int = Field(..., description="Device CRD ID in database")
    device_id: str = Field(..., description="Server-generated device UUID")
    name: str = Field(..., description="Server-generated device name")
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
    vnc_url: Optional[str] = Field(None, description="VNC viewer URL if available")
    created_at: Optional[datetime] = Field(
        None,
        description="Sandbox creation timestamp",
    )

    class Config:
        from_attributes = True


class VncConfigResponse(BaseModel):
    """Response schema for VNC connection configuration.

    Provides the WebSocket URL and authentication signature needed
    to establish a proxied VNC connection through server.cjs.
    """

    wss_url: str = Field(..., description="Upstream Nevis VNC WebSocket URL")
    signature: str = Field(
        ..., description="X-Signature header value for upstream auth"
    )
    sandbox_id: str = Field(..., description="Nevis sandbox ID")


class CloudDeviceFileConfigResponse(BaseModel):
    """Response schema for the cloud device files panel."""

    sandbox_id: str = Field(..., description="Nevis sandbox ID")
    ip_address: Optional[str] = Field(None, description="VM IP address if assigned")
    files_url: Optional[str] = Field(
        None, description="Embedded files service URL if available"
    )
    available: bool = Field(..., description="Whether the files service is reachable")


class CloudDeviceLimitError(BaseModel):
    """Error response when cloud device limit is reached."""

    detail: str = Field(..., description="Error message")
    max_devices: int = Field(..., description="Maximum allowed cloud devices")
    current_count: int = Field(..., description="Current cloud device count")
