# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Canvas schemas for API requests and responses.

Canvas is a collaborative document editing feature that supports
AI and user bidirectional editing with diff display and version history.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class CanvasVersionSource(str, Enum):
    """Source of canvas version modification."""

    USER = "user"
    AI = "ai"


class VersionInfo(BaseModel):
    """Version history entry."""

    version: int = Field(..., description="Version number")
    content: str = Field(..., description="Document content at this version")
    timestamp: str = Field(..., description="ISO 8601 timestamp")
    source: CanvasVersionSource = Field(..., description="Modification source")
    old_str: Optional[str] = Field(None, description="Replaced text (for AI edits)")
    new_str: Optional[str] = Field(None, description="Replacement text (for AI edits)")


class CanvasTypeData(BaseModel):
    """Type data structure for canvas context."""

    filename: str = Field(default="untitled.txt", description="Document filename")
    content: str = Field(default="", description="Current document content")
    version: int = Field(default=1, description="Current version number")
    versions: List[VersionInfo] = Field(
        default_factory=list, description="Version history"
    )
    created_at: str = Field(..., description="Creation timestamp")
    updated_at: str = Field(..., description="Last update timestamp")


# ============================================================
# Request Schemas
# ============================================================


class CanvasCreateRequest(BaseModel):
    """Request to create a new canvas."""

    subtask_id: int = Field(..., description="Subtask ID to associate canvas with")
    filename: Optional[str] = Field(
        default="untitled.txt", description="Initial filename"
    )
    content: Optional[str] = Field(default="", description="Initial content")


class CanvasUpdateRequest(BaseModel):
    """Request to update canvas content (user edit)."""

    content: str = Field(..., description="New document content")


class CanvasRollbackRequest(BaseModel):
    """Request to rollback to a specific version."""

    version: int = Field(..., description="Version number to rollback to")


class UpdateCanvasToolInput(BaseModel):
    """Input for update_canvas tool (AI edit)."""

    old_str: str = Field(
        ..., description="Text to replace, must uniquely match in document"
    )
    new_str: str = Field(..., description="Replacement text")


# ============================================================
# Response Schemas
# ============================================================


class CanvasResponse(BaseModel):
    """Canvas response with full content."""

    id: int = Field(..., description="Canvas context ID")
    subtask_id: int = Field(..., description="Associated subtask ID")
    filename: str = Field(..., description="Document filename")
    content: str = Field(..., description="Current document content")
    version: int = Field(..., description="Current version number")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")

    class Config:
        from_attributes = True


class CanvasVersionResponse(BaseModel):
    """Response for version history listing."""

    versions: List[VersionInfo] = Field(..., description="List of version entries")


class CanvasVersionDetailResponse(BaseModel):
    """Response for a specific version."""

    version: int = Field(..., description="Version number")
    content: str = Field(..., description="Document content at this version")
    timestamp: str = Field(..., description="Version timestamp")
    source: CanvasVersionSource = Field(..., description="Modification source")


class CanvasUpdateResult(BaseModel):
    """Result of canvas update operation."""

    success: bool = Field(..., description="Whether the update succeeded")
    new_content: Optional[str] = Field(None, description="Updated document content")
    version: Optional[int] = Field(None, description="New version number")
    diff_info: Optional[Dict[str, str]] = Field(
        None, description="Diff information (old_str, new_str)"
    )
    error: Optional[str] = Field(None, description="Error message if failed")


class CanvasBrief(BaseModel):
    """Brief canvas info for listing."""

    id: int = Field(..., description="Canvas context ID")
    subtask_id: int = Field(..., description="Associated subtask ID")
    filename: str = Field(..., description="Document filename")
    version: int = Field(..., description="Current version number")
    content_preview: str = Field(
        ..., description="First 100 characters of content"
    )
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")

    class Config:
        from_attributes = True
