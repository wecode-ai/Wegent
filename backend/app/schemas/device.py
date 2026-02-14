# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device schemas for request/response validation.
"""

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class DeviceStatusEnum(str, Enum):
    """Device online status enumeration."""

    ONLINE = "online"
    OFFLINE = "offline"
    BUSY = "busy"


class DeviceType(str, Enum):
    """Device type enumeration.

    Defines the type of device, supporting local devices and cloud providers.
    """

    LOCAL = "local"
    CLOUD = "cloud"


class DeviceConnectionMode(str, Enum):
    """Device connection mode enumeration.

    Defines how the device connects to the backend.
    """

    WEBSOCKET = "websocket"
    # Future connection modes (not implemented yet):
    # API = "api"  # For cloud provider API-based connections


# Maximum concurrent tasks per device
MAX_DEVICE_SLOTS = 5


class DeviceRunningTask(BaseModel):
    """Information about a task running on a device."""

    task_id: int = Field(..., description="Parent task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    title: str = Field(..., description="Task title")
    status: str = Field(..., description="Task status")
    created_at: Optional[str] = Field(None, description="Task creation timestamp")


class DeviceInfo(BaseModel):
    """Response schema for device information."""

    id: int = Field(..., description="Device CRD ID in kinds table")
    device_id: str = Field(..., description="Device unique identifier")
    name: str = Field(..., description="Device name")
    status: DeviceStatusEnum = Field(..., description="Device online status")
    is_default: bool = Field(False, description="Whether this is the default device")
    last_heartbeat: Optional[datetime] = Field(
        None, description="Last heartbeat timestamp"
    )
    # Device type and connection mode
    device_type: DeviceType = Field(
        DeviceType.LOCAL, description="Device type (local or cloud)"
    )
    connection_mode: DeviceConnectionMode = Field(
        DeviceConnectionMode.WEBSOCKET, description="How device connects to backend"
    )
    capabilities: Optional[List[str]] = Field(
        None, description="Device capabilities/tags (e.g., 'gpu', 'high-memory')"
    )
    slot_used: int = Field(0, description="Number of slots currently in use")
    slot_max: int = Field(MAX_DEVICE_SLOTS, description="Maximum concurrent task slots")
    running_tasks: List[DeviceRunningTask] = Field(
        default_factory=list, description="List of tasks running on this device"
    )
    # Version information
    executor_version: Optional[str] = Field(
        None, description="Device's current executor version"
    )
    latest_version: Optional[str] = Field(
        None, description="Latest available executor version"
    )
    update_available: bool = Field(False, description="Whether an update is available")

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
    device_type: DeviceType = Field(
        DeviceType.LOCAL,
        description="Device type (default: local)",
    )
    capabilities: Optional[List[str]] = Field(
        None,
        description="Device capabilities/tags (e.g., 'gpu', 'high-memory')",
    )
    executor_version: Optional[str] = Field(
        None,
        max_length=50,
        description="Executor version (e.g., '1.0.0')",
    )


class DeviceHeartbeatPayload(BaseModel):
    """Payload for device heartbeat via WebSocket."""

    device_id: str = Field(..., description="Device unique identifier")
    running_task_ids: List[int] = Field(
        default_factory=list, description="List of active task IDs on this device"
    )
    executor_version: Optional[str] = Field(
        None,
        max_length=50,
        description="Executor version (e.g., '1.0.0')",
    )


class DeviceStatusPayload(BaseModel):
    """Payload for device status update via WebSocket."""

    device_id: str = Field(..., description="Device unique identifier")
    status: DeviceStatusEnum = Field(..., description="New device status")


class DeviceOnlineEvent(BaseModel):
    """Event payload for device coming online."""

    device_id: str
    name: str
    status: DeviceStatusEnum = DeviceStatusEnum.ONLINE


class DeviceOfflineEvent(BaseModel):
    """Event payload for device going offline."""

    device_id: str


class DeviceStatusEvent(BaseModel):
    """Event payload for device status change."""

    device_id: str
    status: DeviceStatusEnum


class DeviceSlotUpdateEvent(BaseModel):
    """Event payload for device slot usage change."""

    device_id: str
    slot_used: int
    slot_max: int
    running_tasks: List[DeviceRunningTask]
