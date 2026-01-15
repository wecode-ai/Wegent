# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for task services (app field in Task JSON)."""

from typing import Any, Optional

from pydantic import BaseModel, Field


class ServiceUpdate(BaseModel):
    """Request model for updating service/app fields.

    All fields are optional - only provided fields will be merged
    with existing app data.
    """

    name: Optional[str] = Field(None, description="Application name")
    host: Optional[str] = Field(None, description="Host address")
    previewUrl: Optional[str] = Field(None, description="Application preview URL")
    mysql: Optional[str] = Field(
        None, description="MySQL connection string (mysql://user:pass@host:port/db)"
    )


class ServiceDeleteRequest(BaseModel):
    """Request model for deleting service/app fields."""

    fields: list[str] = Field(..., description="List of field names to delete from app")


class ServiceResponse(BaseModel):
    """Response model for service/app data."""

    app: dict[str, Any] = Field(default_factory=dict, description="App configuration")
