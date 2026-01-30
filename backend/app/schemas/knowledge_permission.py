# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for knowledge base permission management.
"""

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class PermissionLevel(str, Enum):
    """Permission level for knowledge base access."""

    VIEW = "view"  # Can view documents and use QA
    EDIT = "edit"  # Can view, edit documents, add/delete documents
    MANAGE = "manage"  # Can do everything + manage other users' permissions


class ApprovalStatus(str, Enum):
    """Approval status for permission requests."""

    PENDING = "pending"  # Request is pending approval
    APPROVED = "approved"  # Request has been approved
    REJECTED = "rejected"  # Request has been rejected


class PermissionRequestCreate(BaseModel):
    """Schema for requesting access to a knowledge base."""

    permission_level: PermissionLevel = Field(
        ...,
        description="Requested permission level: view, edit, or manage",
    )


class PermissionAction(BaseModel):
    """Schema for approving or rejecting a permission request."""

    action: str = Field(
        ..., pattern="^(approve|reject)$", description="Action: approve or reject"
    )
    permission_level: Optional[PermissionLevel] = Field(
        None,
        description="Permission level to grant (required for approve action)",
    )


class PermissionLevelUpdate(BaseModel):
    """Schema for updating permission level."""

    permission_level: PermissionLevel = Field(
        ..., description="New permission level: view, edit, or manage"
    )


class PermissionResponse(BaseModel):
    """Schema for permission record response."""

    id: int
    knowledge_base_id: int
    user_id: int
    user_name: Optional[str] = None
    user_email: Optional[str] = None
    permission_level: PermissionLevel
    approval_status: ApprovalStatus
    requested_by: int
    requested_by_name: Optional[str] = None
    approved_by: Optional[int] = None
    approved_by_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PermissionListResponse(BaseModel):
    """Schema for permission list response."""

    total: int
    items: list[PermissionResponse]


class ShareLinkResponse(BaseModel):
    """Schema for share link response."""

    share_url: str = Field(..., description="Share URL for the knowledge base")


class PermissionCheckResponse(BaseModel):
    """Schema for permission check response."""

    has_access: bool = Field(..., description="Whether user has access to the KB")
    permission_level: Optional[PermissionLevel] = Field(
        None, description="User's permission level if has_access is True"
    )
    is_owner: bool = Field(..., description="Whether user is the KB owner")