# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API Key schemas for request/response validation.
"""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class APIKeyCreate(BaseModel):
    """Request schema for creating an API key."""

    name: str = Field(..., min_length=1, max_length=100, description="Key name")
    description: Optional[str] = Field(
        None, max_length=500, description="Key description"
    )


class APIKeyResponse(BaseModel):
    """Response schema for API key (without the actual key)."""

    id: int
    name: str
    key_prefix: str  # Display prefix, e.g., "wg-abc123..."
    description: Optional[str] = None
    expires_at: datetime
    last_used_at: datetime
    created_at: datetime
    is_active: bool

    class Config:
        from_attributes = True


class APIKeyCreatedResponse(APIKeyResponse):
    """Response schema when creating an API key (includes full key, shown only once)."""

    key: str  # Full key, only returned at creation time


class APIKeyListResponse(BaseModel):
    """Response schema for listing API keys."""

    items: List[APIKeyResponse]
    total: int


# Service Key Schemas


class ServiceKeyCreate(BaseModel):
    """Request schema for creating a service key."""

    name: str = Field(..., min_length=1, max_length=100, description="Key name")
    description: Optional[str] = Field(
        None, max_length=500, description="Key description"
    )


class ServiceKeyResponse(BaseModel):
    """Response schema for service key (without the actual key)."""

    id: int
    name: str
    key_prefix: str  # Display prefix, e.g., "wg-abc123..."
    description: Optional[str] = None
    expires_at: datetime
    last_used_at: datetime
    created_at: datetime
    is_active: bool
    created_by: Optional[str] = None  # Creator's username

    class Config:
        from_attributes = True


class ServiceKeyCreatedResponse(ServiceKeyResponse):
    """Response schema when creating a service key (includes full key, shown only once)."""

    key: str  # Full key, only returned at creation time


class ServiceKeyListResponse(BaseModel):
    """Response schema for listing service keys."""

    items: List[ServiceKeyResponse]
    total: int


# Admin Personal Key Schemas (for admin management of user's personal keys)


class AdminPersonalKeyResponse(BaseModel):
    """Response schema for admin personal key management."""

    id: int
    user_id: int
    user_name: str  # Username for display
    name: str
    key_prefix: str
    description: Optional[str] = None
    expires_at: datetime
    last_used_at: datetime
    created_at: datetime
    is_active: bool

    class Config:
        from_attributes = True


class AdminPersonalKeyListResponse(BaseModel):
    """Response schema for admin listing personal keys."""

    items: List[AdminPersonalKeyResponse]
    total: int
