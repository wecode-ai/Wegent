# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Public contracts for explicit Issue dispatching."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

DispatchTargetType = Literal["human", "agent", "group"]
DispatchAssigneeType = Literal["human", "agent"]
DispatchStatus = Literal["active", "completed", "cancelled"]
DispatchRoundStatus = Literal[
    "planning",
    "executing",
    "evaluating",
    "closed",
    "cancelled",
]
DispatchTaskStatus = Literal[
    "assigned",
    "queued",
    "running",
    "submitted",
    "failed",
    "needs_rework",
    "cancelled",
]


class IssueDispatchCreate(BaseModel):
    target_type: DispatchTargetType
    target_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=1, max_length=128)
    task_title: str | None = Field(default=None, max_length=255)
    instructions: str = Field(default="", max_length=100_000)


class IssueDispatchRoundTaskCreate(BaseModel):
    task_title: str = Field(min_length=1, max_length=255)
    instructions: str = Field(min_length=1, max_length=100_000)
    assignee_type: DispatchAssigneeType
    assignee_id: str = Field(min_length=1, max_length=128)
    workflow_stage_id: str | None = Field(default=None, max_length=128)


class IssueDispatchRoundCreate(BaseModel):
    idempotency_key: str = Field(min_length=1, max_length=128)
    tasks: list[IssueDispatchRoundTaskCreate] = Field(min_length=1, max_length=50)


class IssueDispatchDecisionCreate(BaseModel):
    idempotency_key: str = Field(min_length=1, max_length=128)
    target_status: str = Field(min_length=1, max_length=32)
    reason: str = Field(min_length=1, max_length=10_000)


class IssueDispatchOutcomeCreate(BaseModel):
    event_id: str = Field(min_length=1, max_length=128)
    status: Literal["submitted", "failed", "needs_rework", "cancelled"]
    summary: str = Field(default="", max_length=100_000)
    delivery_id: str | None = Field(default=None, max_length=64)
    evidence: list[dict[str, object]] = Field(default_factory=list, max_length=100)


class IssueDispatchCandidateView(BaseModel):
    target_type: DispatchTargetType
    target_id: str
    name: str
    execution_location: str


class IssueDispatchCandidateListResponse(BaseModel):
    items: list[IssueDispatchCandidateView]


class IssueDispatchTaskActionCreate(BaseModel):
    reason: str = Field(default="", max_length=10_000)


class IssueDispatchTaskView(BaseModel):
    id: str
    task_title: str
    instructions: str
    assignee_type: DispatchAssigneeType
    assignee_id: str
    assignee_name: str
    workflow_stage_id: str | None
    status: DispatchTaskStatus
    linked_item_id: str | None = None
    execution_id: int | None = None
    execution_location: Literal["local", "cloud"] | None = None
    delivery_id: str | None = None
    summary: str = ""
    created_at: datetime
    updated_at: datetime


class IssueDispatchRoundView(BaseModel):
    id: str
    sequence: int
    status: DispatchRoundStatus
    tasks: list[IssueDispatchTaskView]
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class IssueDispatchView(BaseModel):
    id: str
    project_id: str
    issue_id: str
    target_type: DispatchTargetType
    target_id: str
    target_name: str
    status: DispatchStatus
    leader_type: DispatchAssigneeType | None = None
    leader_id: str | None = None
    leader_name: str | None = None
    manager_turn_count: int = 0
    execution_location: str = ""
    active_round_id: str | None = None
    rounds: list[IssueDispatchRoundView] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class IssueDispatchListResponse(BaseModel):
    items: list[IssueDispatchView]
