# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for impersonation feature.
"""

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


# Status type for impersonation requests
ImpersonationStatus = Literal["pending", "approved", "rejected", "expired", "used"]


# Request schemas
class ImpersonationRequestCreate(BaseModel):
    """Schema for creating an impersonation request."""

    target_user_id: int = Field(..., description="ID of the user to impersonate")


class ImpersonationRequestResponse(BaseModel):
    """Schema for impersonation request response."""

    id: int
    admin_user_id: int
    admin_user_name: str
    target_user_id: int
    target_user_name: str
    token: str
    status: ImpersonationStatus
    confirmation_url: str
    expires_at: datetime
    approved_at: Optional[datetime] = None
    session_expires_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ImpersonationRequestListResponse(BaseModel):
    """Schema for paginated list of impersonation requests."""

    total: int
    items: List[ImpersonationRequestResponse]


class ImpersonationConfirmInfo(BaseModel):
    """Schema for impersonation confirmation page information."""

    id: int
    admin_user_name: str
    target_user_name: str
    status: ImpersonationStatus
    expires_at: datetime
    remaining_seconds: int
    created_at: datetime


class ImpersonationStartResponse(BaseModel):
    """Schema for starting an impersonation session."""

    access_token: str
    token_type: str = "bearer"
    impersonated_user_id: int
    impersonated_user_name: str
    session_expires_at: datetime


class ImpersonationExitResponse(BaseModel):
    """Schema for exiting an impersonation session."""

    access_token: str
    token_type: str = "bearer"
    message: str = "Successfully exited impersonation session"


# Audit log schemas
class ImpersonationAuditLogResponse(BaseModel):
    """Schema for audit log response."""

    id: int
    impersonation_request_id: int
    admin_user_id: int
    admin_user_name: str
    target_user_id: int
    target_user_name: str
    action: str
    method: str
    path: str
    request_body: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ImpersonationAuditLogListResponse(BaseModel):
    """Schema for paginated list of audit logs."""

    total: int
    items: List[ImpersonationAuditLogResponse]


# User info response with impersonation status
class UserInfoWithImpersonation(BaseModel):
    """Extended user info with impersonation status."""

    id: int
    user_name: str
    email: Optional[str] = None
    role: str
    is_impersonating: bool = False
    impersonator_name: Optional[str] = None
    impersonation_expires_at: Optional[datetime] = None
    impersonation_request_id: Optional[int] = None

    class Config:
        from_attributes = True
