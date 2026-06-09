# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device schemas for request/response validation.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

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


class BindShell(str, Enum):
    """Bind shell type enumeration.

    Defines which shell runtime the device is bound to.
    """

    CLAUDECODE = "claudecode"
    OPENCLAW = "openclaw"


class DeviceConnectionMode(str, Enum):
    """Device connection mode enumeration.

    Defines how the device connects to the backend.
    """

    WEBSOCKET = "websocket"
    # Future connection modes (not implemented yet):
    # API = "api"  # For cloud provider API-based connections


# Maximum concurrent tasks per device (0 = unlimited)
# With ephemeral CC sessions (auto-close after each message),
# slot limits are no longer needed for local devices.
MAX_DEVICE_SLOTS = 0


class DeviceRunningTask(BaseModel):
    """Information about a task running on a device."""

    task_id: int = Field(..., description="Parent task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    title: str = Field(..., description="Task title")
    status: str = Field(..., description="Task status")
    created_at: Optional[str] = Field(None, description="Task creation timestamp")


class CloudConfig(BaseModel):
    """Cloud device configuration from Device CRD spec."""

    sandboxId: str = Field(..., description="Cloud sandbox ID")
    imageId: str = Field(..., description="Image ID used for VM creation")
    createdAt: Optional[str] = Field(
        None, description="Cloud device creation timestamp"
    )


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
    # Network information
    client_ip: Optional[str] = Field(None, description="Device's client IP address")
    # Cloud device specific config
    cloud_config: Optional[CloudConfig] = Field(
        None, description="Cloud device configuration (only for cloud devices)"
    )
    # Shell binding type
    bind_shell: BindShell = Field(
        BindShell.CLAUDECODE,
        description="Shell runtime binding (claudecode or openclaw)",
    )

    class Config:
        from_attributes = True


class DeviceListResponse(BaseModel):
    """Response schema for listing online devices."""

    items: List[DeviceInfo]
    total: int


class DeviceCommandRequest(BaseModel):
    """Request model for executing a command on a local device."""

    command_key: str = Field(
        ...,
        min_length=1,
        description="Configured command key to execute",
    )
    path: Optional[str] = Field(None, description="Execution path for the command")
    args: List[str] = Field(
        default_factory=list,
        description="Command arguments appended after the configured command",
    )
    cwd: Optional[str] = Field(
        None,
        description="Deprecated alias for path; path takes precedence when both are set",
    )
    env: Dict[str, str] = Field(
        default_factory=dict,
        description="Additional environment variables for the command",
    )
    timeout_seconds: int = Field(
        default=60,
        gt=0,
        le=600,
        description="Command timeout in seconds",
    )
    max_output_bytes: int = Field(
        default=1024 * 1024,
        gt=0,
        le=5 * 1024 * 1024,
        description="Maximum stdout and stderr bytes returned separately",
    )


class DeviceCommandResponse(BaseModel):
    """Response model for a completed local device command."""

    success: bool
    exit_code: Optional[int] = None
    stdout: Union[str, List[str], List[Dict[str, Any]]] = ""
    stderr: str = ""
    duration: float
    timed_out: bool = False
    error: Optional[str] = None
    stdout_truncated: bool = False
    stderr_truncated: bool = False


class DeviceCapabilitySyncRequest(BaseModel):
    """Request model for syncing global local executor capabilities."""

    skill_ids: List[int] = Field(
        default_factory=list,
        description="Executable Skill Kind IDs to sync.",
    )
    installed_skill_ids: List[int] = Field(
        default_factory=list,
        description="InstalledSkill Kind IDs to resolve and sync.",
    )
    installed_mcp_ids: List[int] = Field(
        default_factory=list,
        description="InstalledMCP Kind IDs to resolve and sync.",
    )
    installed_plugin_ids: List[int] = Field(
        default_factory=list,
        description="InstalledPlugin Kind IDs to resolve and sync.",
    )
    mcp_ids: List[str] = Field(
        default_factory=list,
        description="Deprecated server-key based MCP IDs; use installed_mcp_ids.",
    )
    mode: Literal["merge", "replace"] = Field(
        "merge",
        description="How the device should apply the capability set.",
    )


class DeviceCapabilityItemResult(BaseModel):
    """Per-item capability sync result."""

    id: Optional[Union[int, str]] = None
    name: Optional[str] = None
    server_name: Optional[str] = None
    status: str = "ok"
    error: Optional[str] = None


class DeviceCapabilitySyncResult(BaseModel):
    """Per-device capability sync result."""

    device_id: str
    success: bool
    error: Optional[str] = None
    skills: List[DeviceCapabilityItemResult] = Field(default_factory=list)
    plugins: List[DeviceCapabilityItemResult] = Field(default_factory=list)
    mcps: List[DeviceCapabilityItemResult] = Field(default_factory=list)
    errors: List[Dict[str, Any]] = Field(default_factory=list)


class DeviceCapabilitySyncResponse(BaseModel):
    """Response model for capability sync requests."""

    success: bool = True
    device_id: str = ""
    mode: Literal["merge", "replace"] = "merge"
    skills: List[DeviceCapabilityItemResult] = Field(default_factory=list)
    plugins: List[DeviceCapabilityItemResult] = Field(default_factory=list)
    mcps: List[DeviceCapabilityItemResult] = Field(default_factory=list)
    errors: List[Dict[str, Any]] = Field(default_factory=list)
    synced: int = 0
    failed: int = 0
    skipped: int = 0
    results: List[DeviceCapabilitySyncResult] = Field(default_factory=list)


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
    client_ip: Optional[str] = Field(
        None,
        max_length=50,
        description="Device's client IP address",
    )
    bind_shell: BindShell = Field(
        BindShell.CLAUDECODE,
        description="Shell runtime binding (claudecode or openclaw)",
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
    capabilities: Optional[Dict[str, Any]] = Field(
        None,
        description="Sanitized local global capability state reported by executor",
    )
    runtime_auth_files: Optional[Dict[str, Any]] = Field(
        None,
        description="Sanitized runtime auth file existence state reported by executor",
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


class DeviceUpgradeStatusEvent(BaseModel):
    """Event payload for device upgrade status updates.

    Sent from executor to backend to report upgrade progress and results.
    """

    device_id: str = Field(..., description="Device unique identifier")
    status: str = Field(
        ...,
        description="Upgrade status: checking | downloading | installing | restarting | success | error | skipped | busy",
    )
    message: str = Field(..., description="Human-readable status message")
    old_version: Optional[str] = Field(
        None, description="Version before upgrade (if applicable)"
    )
    new_version: Optional[str] = Field(
        None, description="Version after upgrade (if applicable)"
    )
    progress: Optional[int] = Field(
        None, description="Download progress (0-100, if applicable)"
    )
    error: Optional[str] = Field(
        None, description="Error details (if status is 'error')"
    )
