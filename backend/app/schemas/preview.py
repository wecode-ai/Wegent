# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Preview feature schemas for Workbench live preview functionality.
"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class PreviewStatus(str, Enum):
    """Preview service status enum"""

    DISABLED = "disabled"
    STARTING = "starting"
    READY = "ready"
    ERROR = "error"
    STOPPED = "stopped"


class PreviewConfigSpec(BaseModel):
    """Preview configuration spec from .wegent.yaml"""

    enabled: bool = Field(default=True, description="Whether preview is enabled")
    start_command: str = Field(..., alias="startCommand", description="Command to start dev server")
    port: int = Field(..., description="Dev server port")
    ready_pattern: str = Field(..., alias="readyPattern", description="Pattern to detect server ready")
    working_dir: str = Field(default=".", alias="workingDir", description="Working directory")
    env: Optional[Dict[str, str]] = Field(default=None, description="Environment variables")

    class Config:
        populate_by_name = True


class PreviewConfig(BaseModel):
    """Full preview configuration from .wegent.yaml"""

    api_version: str = Field(default="agent.wecode.io/v1", alias="apiVersion")
    kind: str = Field(default="ProjectConfig")
    metadata: Dict[str, Any] = Field(default_factory=dict)
    spec: Dict[str, Any] = Field(default_factory=dict)

    class Config:
        populate_by_name = True

    def get_preview_spec(self) -> Optional[PreviewConfigSpec]:
        """Extract preview spec from config"""
        preview_data = self.spec.get("preview")
        if not preview_data:
            return None
        try:
            return PreviewConfigSpec(**preview_data)
        except Exception:
            return None


class PreviewConfigResponse(BaseModel):
    """Response for GET /api/tasks/{task_id}/preview/config"""

    enabled: bool = Field(description="Whether preview is enabled for this task")
    port: Optional[int] = Field(default=None, description="Preview server port")
    status: PreviewStatus = Field(description="Current preview service status")
    url: Optional[str] = Field(default=None, description="Preview URL if available")
    start_command: Optional[str] = Field(default=None, description="Command to start server")
    ready_pattern: Optional[str] = Field(default=None, description="Pattern to detect ready")
    error: Optional[str] = Field(default=None, description="Error message if any")


class PreviewStartRequest(BaseModel):
    """Request for POST /api/tasks/{task_id}/preview/start"""

    force: bool = Field(default=False, description="Force restart even if already running")


class PreviewStartResponse(BaseModel):
    """Response for POST /api/tasks/{task_id}/preview/start"""

    success: bool = Field(description="Whether the operation succeeded")
    message: str = Field(description="Status message")
    status: PreviewStatus = Field(description="Current preview status")
    url: Optional[str] = Field(default=None, description="Preview URL if available")


class PreviewStopResponse(BaseModel):
    """Response for POST /api/tasks/{task_id}/preview/stop"""

    success: bool = Field(description="Whether the operation succeeded")
    message: str = Field(description="Status message")


class ViewportSize(str, Enum):
    """Viewport size options for responsive preview"""

    DESKTOP = "desktop"  # 100% width
    TABLET = "tablet"  # 768px
    MOBILE = "mobile"  # 375px


class PreviewStateUpdate(BaseModel):
    """WebSocket event for preview state updates"""

    task_id: int = Field(description="Task ID")
    status: PreviewStatus = Field(description="Preview status")
    port: Optional[int] = Field(default=None, description="Server port")
    url: Optional[str] = Field(default=None, description="Preview URL")
    error: Optional[str] = Field(default=None, description="Error message")
    output: Optional[str] = Field(default=None, description="Recent server output")
