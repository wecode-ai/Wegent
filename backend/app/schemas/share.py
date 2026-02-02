# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for unified resource sharing.

Provides request/response schemas for share links and resource members.
"""

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ResourceType(str, Enum):
    """Supported resource types for sharing."""

    TEAM = "Team"
    TASK = "Task"
    KNOWLEDGE_BASE = "KnowledgeBase"


class PermissionLevel(str, Enum):
    """Permission levels for resource access."""

    VIEW = "view"
    EDIT = "edit"
    MANAGE = "manage"


class MemberStatus(str, Enum):
    """Status of a resource member."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


# =============================================================================
# Share Link Schemas
# =============================================================================


class ShareLinkConfig(BaseModel):
    """Configuration for creating a share link."""

    require_approval: bool = Field(
        default=True, description="Whether joining requires approval"
    )
    default_permission_level: PermissionLevel = Field(
        default=PermissionLevel.VIEW, description="Default permission level for joiners"
    )
    expires_in_hours: Optional[int] = Field(
        default=None,
        description="Hours until link expires (None = never expires)",
        ge=1,
    )


class ShareLinkCreate(BaseModel):
    """Request body for creating a share link."""

    config: ShareLinkConfig = Field(
        default_factory=ShareLinkConfig, description="Share link configuration"
    )


class ShareLinkUpdate(BaseModel):
    """Request body for updating a share link."""

    require_approval: Optional[bool] = Field(
        default=None, description="Whether joining requires approval"
    )
    default_permission_level: Optional[PermissionLevel] = Field(
        default=None, description="Default permission level for joiners"
    )
    expires_in_hours: Optional[int] = Field(
        default=None, description="Hours until link expires (None = never expires)"
    )
    is_active: Optional[bool] = Field(
        default=None, description="Whether the link is active"
    )


class ShareLinkResponse(BaseModel):
    """Response containing share link information."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    resource_type: str
    resource_id: int
    share_url: str = Field(description="Full share URL")
    share_token: str = Field(description="Share token for joining")
    require_approval: bool
    default_permission_level: str
    expires_at: Optional[datetime] = None
    is_active: bool
    created_by_user_id: int
    created_at: datetime
    updated_at: datetime


class ShareLinkInDB(BaseModel):
    """Share link model from database."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    resource_type: str
    resource_id: int
    share_token: str
    require_approval: bool
    default_permission_level: str
    expires_at: Optional[datetime] = None
    created_by_user_id: int
    is_active: bool
    created_at: datetime
    updated_at: datetime


# =============================================================================
# Resource Member Schemas
# =============================================================================


class ResourceMemberCreate(BaseModel):
    """Request body for adding a member directly."""

    user_id: int = Field(description="User ID to add as member")
    permission_level: PermissionLevel = Field(
        default=PermissionLevel.VIEW, description="Permission level"
    )


class ResourceMemberUpdate(BaseModel):
    """Request body for updating member permissions."""

    permission_level: Optional[PermissionLevel] = Field(
        default=None, description="New permission level"
    )


class ResourceMemberResponse(BaseModel):
    """Response containing resource member information."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    resource_type: str
    resource_id: int
    user_id: int
    user_name: Optional[str] = None  # Populated from user lookup
    permission_level: str
    status: str
    invited_by_user_id: int
    invited_by_user_name: Optional[str] = None  # Populated from user lookup
    reviewed_by_user_id: Optional[int] = None
    reviewed_by_user_name: Optional[str] = None  # Populated from user lookup
    reviewed_at: Optional[datetime] = None
    copied_resource_id: Optional[int] = None  # For Task type
    requested_at: datetime
    created_at: datetime
    updated_at: datetime


class ResourceMemberInDB(BaseModel):
    """Resource member model from database."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    resource_type: str
    resource_id: int
    user_id: int
    permission_level: str
    status: str
    invited_by_user_id: int
    share_link_id: Optional[int] = None
    reviewed_by_user_id: Optional[int] = None
    reviewed_at: Optional[datetime] = None
    copied_resource_id: Optional[int] = None
    requested_at: datetime
    created_at: datetime
    updated_at: datetime


class MemberListResponse(BaseModel):
    """Response containing list of resource members."""

    members: List[ResourceMemberResponse]
    total: int


# =============================================================================
# Join Request Schemas
# =============================================================================


class JoinByLinkRequest(BaseModel):
    """Request body for joining via share link."""

    share_token: str = Field(description="Share token from URL")
    requested_permission_level: Optional[PermissionLevel] = Field(
        default=None, description="Requested permission level (optional)"
    )


class JoinByLinkResponse(BaseModel):
    """Response for join request."""

    message: str
    status: MemberStatus = Field(description="Current status (pending/approved)")
    member_id: int = Field(description="Created member record ID")
    resource_type: str
    resource_id: int
    copied_resource_id: Optional[int] = None  # For Task type when auto-approved


# =============================================================================
# Approval Request Schemas
# =============================================================================


class PendingRequestResponse(BaseModel):
    """Response containing pending approval request."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    user_name: Optional[str] = None
    requested_permission_level: str
    requested_at: datetime


class PendingRequestListResponse(BaseModel):
    """Response containing list of pending requests."""

    requests: List[PendingRequestResponse]
    total: int


class ReviewRequestBody(BaseModel):
    """Request body for reviewing a join request."""

    approved: bool = Field(description="Whether to approve the request")
    permission_level: Optional[PermissionLevel] = Field(
        default=None,
        description="Permission level to grant (only for approval, defaults to requested level)",
    )


class ReviewRequestResponse(BaseModel):
    """Response for review action."""

    message: str
    member_id: int
    new_status: MemberStatus
    permission_level: Optional[str] = None


# =============================================================================
# Public Info Schemas (for share link preview)
# =============================================================================


class ShareInfoResponse(BaseModel):
    """Public response for share link preview (no auth required)."""

    resource_type: str
    resource_id: int
    resource_name: str = Field(description="Name of the shared resource")
    owner_user_id: int
    owner_user_name: str = Field(description="Name of resource owner")
    require_approval: bool
    default_permission_level: str
    is_expired: bool = False


# =============================================================================
# Permission Check Schemas
# =============================================================================


class PermissionCheckRequest(BaseModel):
    """Request for checking user permission."""

    resource_type: ResourceType
    resource_id: int
    user_id: int
    required_level: PermissionLevel


class PermissionCheckResponse(BaseModel):
    """Response for permission check."""

    has_permission: bool
    actual_permission_level: Optional[str] = None
