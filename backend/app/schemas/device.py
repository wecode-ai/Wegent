# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device schemas for request/response validation.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class DeviceStatusEnum(str, Enum):
    """Device online status enumeration."""

    ONLINE = "online"
    OFFLINE = "offline"
    BUSY = "busy"


class SystemStats(BaseModel):
    """System resource statistics from executor."""

    memory_used_mb: float = Field(0, description="Process memory usage in MB")
    memory_total_mb: float = Field(0, description="System total memory in MB")
    memory_percent: float = Field(0, description="Memory usage percentage")
    disk_used_gb: float = Field(0, description="Disk used space in GB")
    disk_total_gb: float = Field(0, description="Disk total space in GB")
    disk_free_gb: float = Field(0, description="Disk free space in GB")
    disk_percent: float = Field(0, description="Disk usage percentage")
    workspace_size_mb: float = Field(0, description="Workspace directory size in MB")
    workspace_count: int = Field(0, description="Number of workspaces")
    log_size_mb: float = Field(0, description="Log directory size in MB")
    cpu_percent: float = Field(0, description="CPU usage percentage")
    uptime_seconds: int = Field(0, description="Executor uptime in seconds")


class TaskStats(BaseModel):
    """Task execution statistics from executor."""

    running_tasks: int = Field(0, description="Currently running tasks")
    queued_tasks: int = Field(0, description="Tasks in queue")
    completed_today: int = Field(0, description="Tasks completed today")


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
    capabilities: Optional[List[str]] = Field(
        None, description="Device capabilities/tags"
    )
    executor_version: Optional[str] = Field(
        None, description="Executor software version"
    )
    version_status: Optional[str] = Field(
        None, description="Version status: up_to_date, update_available, incompatible"
    )
    system_stats: Optional[SystemStats] = Field(
        None, description="System resource statistics"
    )
    task_stats: Optional[TaskStats] = Field(
        None, description="Task execution statistics"
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
    executor_version: Optional[str] = Field(
        None, description="Executor software version"
    )


class DeviceHeartbeatPayload(BaseModel):
    """Payload for device heartbeat via WebSocket."""

    device_id: str = Field(..., description="Device unique identifier")
    executor_version: Optional[str] = Field(
        None, description="Executor software version"
    )
    system_stats: Optional[Dict[str, Any]] = Field(
        None, description="System resource statistics"
    )
    task_stats: Optional[Dict[str, Any]] = Field(
        None, description="Task execution statistics"
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


class WorkspaceSyncPayload(BaseModel):
    """Payload for workspace sync request via WebSocket."""

    device_id: str = Field(..., description="Device unique identifier")
