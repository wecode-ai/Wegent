# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, field_validator

from app.schemas.namespace import GroupRole


class GroupEntityMemberCreate(BaseModel):
    """Entity member creation model for groups."""

    entity_type: str
    entity_id: str
    entity_display_name: Optional[str] = None
    role: GroupRole

    @field_validator("entity_type")
    @classmethod
    def validate_entity_type(cls, v: str) -> str:
        v = v.strip().lower()
        if v in ("user", "namespace"):
            raise ValueError("entity_type cannot be 'user' or 'namespace'")
        return v


class GroupEntityMemberUpdate(BaseModel):
    """Entity member update model for groups."""

    role: GroupRole


class BatchFailedItem(BaseModel):
    """Single batch operation failure item."""

    entity_id: str
    entity_type: str
    error: str


class GroupEntityMemberBatchCreate(BaseModel):
    """Batch create entity members request."""

    members: list[GroupEntityMemberCreate]


class GroupEntityMemberResponse(BaseModel):
    """Entity member response model for groups."""

    entity_type: str
    entity_id: str
    entity_display_name: Optional[str]
    role: GroupRole
    invited_by_user_id: int
    invited_by_user_name: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class GroupEntityMemberBatchResponse(BaseModel):
    """Batch create entity members response."""

    succeeded: list[GroupEntityMemberResponse]
    failed: list[BatchFailedItem]
    total: int = 0
    success_count: int = 0
    failed_count: int = 0
