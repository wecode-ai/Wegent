# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for knowledge base permission management.
"""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class PermissionLevel(str, Enum):
    """Permission level for knowledge base access."""

    VIEW = "view"  # Can browse knowledge base content
    EDIT = "edit"  # Can add, modify, delete documents
    MANAGE = "manage"  # Can manage other users' access permissions


class PermissionStatus(str, Enum):
    """Status of a permission request or assignment."""

    PENDING = "pending"  # Request is awaiting approval
    APPROVED = "approved"  # Request has been approved
    REJECTED = "rejected"  # Request has been rejected


# ============== Permission Request Schemas ==============


class PermissionApplyRequest(BaseModel):
    """Schema for applying for knowledge base access permission."""

    permission_level: PermissionLevel = Field(
        default=PermissionLevel.VIEW,
        description="Requested permission level: view, edit, or manage",
    )


class PermissionApplyResponse(BaseModel):
    """Schema for permission apply response."""

    id: int = Field(..., description="Permission record ID")
    knowledge_base_id: int = Field(..., description="Knowledge base ID")
    permission_level: PermissionLevel = Field(
        ..., description="Requested permission level"
    )
    status: PermissionStatus = Field(..., description="Request status")
    requested_at: datetime = Field(..., description="Request timestamp")
    message: str = Field(..., description="Response message")


# ============== Permission Review Schemas ==============


class ReviewAction(str, Enum):
    """Review action for permission requests."""

    APPROVE = "approve"
    REJECT = "reject"


class PermissionReviewRequest(BaseModel):
    """Schema for reviewing a permission request."""

    action: ReviewAction = Field(..., description="Review action: approve or reject")
    permission_level: Optional[PermissionLevel] = Field(
        None,
        description="Permission level to grant (only used when approving, can adjust from original request)",
    )


class PermissionReviewResponse(BaseModel):
    """Schema for permission review response."""

    id: int = Field(..., description="Permission record ID")
    user_id: int = Field(..., description="User ID")
    permission_level: PermissionLevel = Field(
        ..., description="Granted/requested permission level"
    )
    status: PermissionStatus = Field(..., description="New status after review")
    reviewed_at: datetime = Field(..., description="Review timestamp")
    message: str = Field(..., description="Response message")


# ============== Permission Management Schemas ==============


class PermissionAddRequest(BaseModel):
    """Schema for directly adding user permission (without request)."""

    user_name: str = Field(..., description="Username to add permission for")
    permission_level: PermissionLevel = Field(
        default=PermissionLevel.VIEW,
        description="Permission level to grant",
    )


class PermissionUpdateRequest(BaseModel):
    """Schema for updating a user's permission level."""

    permission_level: PermissionLevel = Field(..., description="New permission level")


# ============== Permission User Info Schemas ==============


class PermissionUserInfo(BaseModel):
    """Schema for user information in permission records."""

    id: int = Field(..., description="Permission record ID")
    user_id: int = Field(..., description="User ID")
    username: str = Field(..., description="Username")
    email: Optional[str] = Field(None, description="User email")
    permission_level: PermissionLevel = Field(..., description="Permission level")
    requested_at: datetime = Field(..., description="Request timestamp")
    reviewed_at: Optional[datetime] = Field(None, description="Review timestamp")
    reviewed_by: Optional[int] = Field(None, description="Reviewer user ID")


class PendingPermissionInfo(BaseModel):
    """Schema for pending permission request information."""

    id: int = Field(..., description="Permission record ID")
    user_id: int = Field(..., description="User ID")
    username: str = Field(..., description="Username")
    email: Optional[str] = Field(None, description="User email")
    permission_level: PermissionLevel = Field(
        ..., description="Requested permission level"
    )
    requested_at: datetime = Field(..., description="Request timestamp")


class ApprovedPermissionsByLevel(BaseModel):
    """Schema for approved permissions grouped by level."""

    view: List[PermissionUserInfo] = Field(
        default_factory=list, description="Users with view permission"
    )
    edit: List[PermissionUserInfo] = Field(
        default_factory=list, description="Users with edit permission"
    )
    manage: List[PermissionUserInfo] = Field(
        default_factory=list, description="Users with manage permission"
    )


class PermissionListResponse(BaseModel):
    """Schema for knowledge base permission list response."""

    pending: List[PendingPermissionInfo] = Field(
        default_factory=list,
        description="Pending permission requests",
    )
    approved: ApprovedPermissionsByLevel = Field(
        default_factory=ApprovedPermissionsByLevel,
        description="Approved permissions grouped by level",
    )


# ============== Current User Permission Schema ==============


class PendingRequestInfo(BaseModel):
    """Schema for current user's pending request info."""

    id: int = Field(..., description="Permission record ID")
    permission_level: PermissionLevel = Field(
        ..., description="Requested permission level"
    )
    requested_at: datetime = Field(..., description="Request timestamp")


class MyPermissionResponse(BaseModel):
    """Schema for current user's permission on a knowledge base."""

    has_access: bool = Field(..., description="Whether user has access to the KB")
    permission_level: Optional[PermissionLevel] = Field(
        None,
        description="User's permission level (null if no access)",
    )
    is_creator: bool = Field(..., description="Whether user is the KB creator")
    pending_request: Optional[PendingRequestInfo] = Field(
        None,
        description="Pending permission request info if exists",
    )


# ============== Permission Response (for CRUD operations) ==============


class PermissionResponse(BaseModel):
    """Schema for single permission record response."""

    id: int = Field(..., description="Permission record ID")
    knowledge_base_id: int = Field(..., description="Knowledge base ID")
    user_id: int = Field(..., description="User ID")
    permission_level: PermissionLevel = Field(..., description="Permission level")
    status: PermissionStatus = Field(..., description="Status")
    requested_at: datetime = Field(..., description="Request timestamp")
    reviewed_at: Optional[datetime] = Field(None, description="Review timestamp")
    reviewed_by: Optional[int] = Field(None, description="Reviewer user ID")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")

    class Config:
        from_attributes = True
