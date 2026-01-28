# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for permission request management.
"""

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class PermissionRequestStatus(str, Enum):
    """Status of a permission request."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


# ============== Permission Request Schemas ==============


class PermissionRequestCreate(BaseModel):
    """Schema for creating a permission request."""

    kind_id: int = Field(..., description="Knowledge base ID to request access to")
    request_reason: Optional[str] = Field(
        None, max_length=1000, description="Reason for requesting access"
    )
    requested_permission_type: str = Field(
        default="read",
        pattern="^(read|download|write)$",
        description="Requested permission type: read, download, or write",
    )


class PermissionRequestProcess(BaseModel):
    """Schema for processing (approve/reject) a permission request."""

    action: str = Field(
        ...,
        pattern="^(approve|reject)$",
        description="Action to take: approve or reject",
    )
    response_message: Optional[str] = Field(
        None, max_length=500, description="Optional response message to the applicant"
    )
    # For approval, can optionally specify a different permission type
    granted_permission_type: Optional[str] = Field(
        None,
        pattern="^(read|download|write|manage)$",
        description="Permission type to grant (only for approve action)",
    )


class PermissionRequestResponse(BaseModel):
    """Schema for permission request response."""

    id: int = Field(..., description="Request ID")
    kind_id: int = Field(..., description="Knowledge base ID")
    resource_type: str = Field(..., description="Resource type")
    applicant_user_id: int = Field(..., description="Applicant user ID")
    applicant_username: str = Field(..., description="Applicant username")
    requested_permission_type: str = Field(..., description="Requested permission type")
    request_reason: Optional[str] = Field(None, description="Request reason")
    status: PermissionRequestStatus = Field(..., description="Request status")
    processed_by_user_id: Optional[int] = Field(None, description="Processor user ID")
    processed_by_username: Optional[str] = Field(None, description="Processor username")
    processed_at: Optional[datetime] = Field(None, description="Processing time")
    response_message: Optional[str] = Field(None, description="Response message")
    created_at: datetime = Field(..., description="Request creation time")
    updated_at: datetime = Field(..., description="Last update time")
    # Additional info for display
    kb_name: Optional[str] = Field(None, description="Knowledge base name")
    kb_description: Optional[str] = Field(
        None, description="Knowledge base description"
    )
    kb_owner_username: Optional[str] = Field(
        None, description="Knowledge base owner username"
    )

    class Config:
        from_attributes = True


class PermissionRequestListResponse(BaseModel):
    """Schema for permission request list response."""

    total: int = Field(..., description="Total number of requests")
    items: list[PermissionRequestResponse] = Field(..., description="List of requests")


class PendingRequestCountResponse(BaseModel):
    """Schema for pending request count response."""

    count: int = Field(..., description="Number of pending requests")


class MyRequestsResponse(BaseModel):
    """Schema for current user's requests response."""

    total: int = Field(..., description="Total number of requests")
    items: list[PermissionRequestResponse] = Field(..., description="List of requests")


class PermissionRequestCheckResponse(BaseModel):
    """Schema for checking if user has pending request."""

    has_pending_request: bool = Field(
        ..., description="Whether user has a pending request for this resource"
    )
    pending_request: Optional[PermissionRequestResponse] = Field(
        None, description="The pending request if exists"
    )
