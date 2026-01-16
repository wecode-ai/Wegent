# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class GroupRole(str, Enum):
    """Group member roles"""

    Owner = "Owner"
    Maintainer = "Maintainer"
    Developer = "Developer"
    Reporter = "Reporter"


class GroupVisibility(str, Enum):
    """Group visibility levels"""

    private = "private"
    internal = "internal"
    public = "public"


class GroupBase(BaseModel):
    """Base group model"""

    name: str = Field(..., min_length=1, max_length=100)
    display_name: Optional[str] = Field(None, max_length=100)
    visibility: GroupVisibility = GroupVisibility.private
    description: str = Field(default="", description="Group description")

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        """Validate group name format"""
        if not v:
            raise ValueError("Group name cannot be empty")

        # Check for invalid characters
        invalid_chars = [
            " ",
            "\t",
            "\n",
            "\r",
            "\\",
            ":",
            ";",
            ",",
            "<",
            ">",
            "?",
            "*",
            "|",
            '"',
            "'",
        ]
        for char in invalid_chars:
            if char in v:
                raise ValueError(f"Group name cannot contain '{char}'")

        # Check depth (max 5 levels)
        depth = v.count("/")
        if depth > 4:  # 0-4 means max 5 levels
            raise ValueError("Group nesting depth cannot exceed 5 levels")

        return v


class GroupCreate(GroupBase):
    """Group creation model"""

    pass


class GroupUpdate(BaseModel):
    """Group update model"""

    display_name: Optional[str] = Field(None, max_length=100)
    visibility: Optional[GroupVisibility] = None
    description: Optional[str] = None


class GroupResponse(GroupBase):
    """Group response model"""

    id: int
    owner_user_id: int
    is_active: bool
    created_at: datetime
    updated_at: datetime
    my_role: Optional[str] = None
    member_count: Optional[int] = None

    class Config:
        from_attributes = True


class GroupListResponse(BaseModel):
    """Group list response with pagination"""

    total: int
    items: list[GroupResponse]
