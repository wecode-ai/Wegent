# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.namespace import GroupRole


class GroupMemberBase(BaseModel):
    """Base group member model"""

    user_id: int
    role: GroupRole


class GroupMemberCreate(GroupMemberBase):
    """Group member creation model"""

    pass


class GroupMemberUpdate(BaseModel):
    """Group member update model"""

    role: GroupRole


class GroupMemberResponse(GroupMemberBase):
    """Group member response model"""

    id: int
    group_name: str
    user_name: Optional[str] = None
    invited_by_user_id: Optional[int] = None
    invited_by_user_name: Optional[str] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AddMemberResult(BaseModel):
    """Result of adding a member operation"""

    success: bool
    message: str
    data: Optional[GroupMemberResponse] = None
