# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, model_validator

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


class GroupMemberBatchUpdateItem(BaseModel):
    """Single member role update in a batch request."""

    user_id: int
    role: GroupRole


class GroupMemberBatchUpdateRequest(BaseModel):
    """Batch member role update request."""

    updates: list[GroupMemberBatchUpdateItem] = Field(
        ..., min_length=1, description="List of member role updates"
    )

    @model_validator(mode="after")
    def validate_unique_user_ids(self) -> "GroupMemberBatchUpdateRequest":
        user_ids = [update.user_id for update in self.updates]
        if len(user_ids) != len(set(user_ids)):
            raise ValueError(
                "Duplicate user_id values are not allowed in batch updates"
            )
        return self


class GroupMemberBatchUpdateFailedItem(BaseModel):
    """Failed member role update in a batch response."""

    user_id: int
    role: GroupRole
    error: str
    error_code: str | None = None


class GroupMemberBatchUpdateResponse(BaseModel):
    """Batch member role update response."""

    updated_members: list["GroupMemberResponse"] = Field(
        default_factory=list, description="Successfully updated members"
    )
    failed_updates: list[GroupMemberBatchUpdateFailedItem] = Field(
        default_factory=list, description="Failed member role updates"
    )
    total_updated: int = Field(0, description="Total number of updated members")
    total_failed: int = Field(0, description="Total number of failed updates")


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
