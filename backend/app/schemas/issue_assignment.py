# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for non-exclusive Issue assignments."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, Field

from app.schemas.delivery import LoopItemCommentResponse, LoopItemResponse

SnowflakeId = Annotated[str, BeforeValidator(str)]
AssignmentTrigger = Literal[
    "manual",
    "rule",
    "workflow",
    "automation",
    "mention",
]


class IssueAssignmentCreate(BaseModel):
    target_type: Literal["human", "agent"]
    target_id: str = Field(min_length=1, max_length=128)
    workflow_step: str | None = Field(default=None, max_length=128)
    comment_body: str | None = Field(default=None, min_length=1, max_length=100_000)
    notify_target: bool = True
    trigger: AssignmentTrigger = "manual"


class IssueAssignmentResponse(BaseModel):
    id: SnowflakeId
    issue_id: str
    target_type: Literal["human", "agent"]
    target_id: str
    target_name: str
    workflow_step: str | None
    comment_id: str | None
    created_by_user_id: int
    created_by_user_name: str | None
    status: Literal["active", "completed", "cancelled"]
    created_at: datetime
    updated_at: datetime


class IssueAssignmentListResponse(BaseModel):
    items: list[IssueAssignmentResponse]


class IssueAssignmentCreateResponse(BaseModel):
    assignment: IssueAssignmentResponse
    comment: LoopItemCommentResponse | None
    issue: LoopItemResponse
