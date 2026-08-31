# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API Key schemas for request/response validation.
"""

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


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


class APIKeyLookupRequest(BaseModel):
    """Request schema for looking up an API key's owner."""

    api_key: str = Field(..., min_length=1, description="Raw API key to look up")


class APIKeyLookupResponse(BaseModel):
    """Response schema for an API key lookup."""

    exists: bool
    user_name: Optional[str] = None


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
    """Creation response containing the full key, which is shown only once."""

    key: str  # Full key, only returned at creation time


class ServiceKeyListResponse(BaseModel):
    """Response schema for listing service keys."""

    items: List[ServiceKeyResponse]
    total: int


class PluginReleaseKeyCreate(BaseModel):
    """Create a short-lived key for one protected GitLab release job."""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=500)
    expiresAt: datetime
    projectIds: List[str] = Field(min_length=1, max_length=20)
    environments: List[Literal["production"]] = Field(
        default_factory=lambda: ["production"], min_length=1
    )

    @field_validator("projectIds")
    @classmethod
    def normalize_project_ids(cls, values: List[str]) -> List[str]:
        normalized = list(
            dict.fromkeys(value.strip() for value in values if value.strip())
        )
        if not normalized:
            raise ValueError("projectIds must contain at least one project")
        return normalized


class PluginReleaseKeyResponse(BaseModel):
    id: int
    name: str
    keyPrefix: str
    description: Optional[str] = None
    scopes: List[str]
    projectIds: List[str]
    environments: List[str]
    expiresAt: datetime
    lastUsedAt: datetime
    createdAt: datetime
    isActive: bool
    createdBy: Optional[str] = None


class PluginReleaseKeyCreatedResponse(PluginReleaseKeyResponse):
    key: str


class PluginReleaseKeyListResponse(BaseModel):
    items: List[PluginReleaseKeyResponse]
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
