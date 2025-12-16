# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API Key schemas for request/response validation.
"""

from datetime import datetime
from typing import List

from pydantic import BaseModel, Field


class APIKeyCreate(BaseModel):
    """Request schema for creating an API key."""

    name: str = Field(..., min_length=1, max_length=100, description="Key name")


class APIKeyResponse(BaseModel):
    """Response schema for API key (without the actual key)."""

    id: int
    name: str
    key_prefix: str  # Display prefix, e.g., "wg-abc123..."
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
