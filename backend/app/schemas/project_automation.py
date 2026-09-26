# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for project-scoped scheduled automations."""

from datetime import datetime
from typing import Any, Literal, Self

from pydantic import ConfigDict, Field, model_validator

from app.schemas.issue_workflow import ProjectWorkflowDefinition
from app.schemas.project_chat import ProjectChatSchema

AutomationRunStatus = Literal[
    "pending",
    "queued",
    "waiting_runtime",
    "waiting_device",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
]
AutomationTargetKind = Literal["human", "agent", "collaboration_group"]
AutomationEventType = Literal[
    "task.created",
    "task.tag_added",
    "task.status_changed",
    "change_request.checks_failed",
    "change_request.merge_conflict",
    "change_request.review_submitted",
    "change_request.comment_created",
    "document.changed",
]


class ProjectAutomationAssignmentSchema(ProjectChatSchema):
    """Strict public contract for one automation assignment strategy."""

    model_config = ConfigDict(extra="forbid")


class ProjectAutomationCreate(ProjectAutomationAssignmentSchema):
    name: str = Field(min_length=1, max_length=255)
    prompt: str = Field(min_length=1, max_length=100_000)
    trigger_type: Literal["manual", "schedule", "event", "workflow"] = "schedule"
    event_type: AutomationEventType | None = None
    event_config: dict[str, Any] = Field(default_factory=dict)
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    execution_device_id: str | None = Field(default=None, max_length=100)
    target_kind: AutomationTargetKind
    target_id: str = Field(min_length=1, max_length=128)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_target(self) -> Self:
        if self.target_kind == "human" and self.execution_device_id:
            raise ValueError("human targets do not use an execution device")
        return self


class ProjectAutomationUpdate(ProjectAutomationAssignmentSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=255)
    prompt: str | None = Field(default=None, min_length=1, max_length=100_000)
    trigger_type: Literal["manual", "schedule", "event", "workflow"] | None = None
    event_type: AutomationEventType | None = None
    event_config: dict[str, Any] | None = None
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    execution_device_id: str | None = Field(default=None, max_length=100)
    target_kind: AutomationTargetKind | None = None
    target_id: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None

    @model_validator(mode="after")
    def validate_target_switch(self) -> Self:
        target_fields = {"target_kind", "target_id"}
        changed_target_fields = target_fields.intersection(self.model_fields_set)
        if changed_target_fields:
            if changed_target_fields != target_fields:
                raise ValueError("target_kind and target_id must be changed together")
            if self.target_kind == "human" and self.execution_device_id:
                raise ValueError("human targets do not use an execution device")
        return self


class ProjectAutomationWorkflowMigration(ProjectChatSchema):
    """Atomically promote the legacy project workflow into one automation."""

    project_version: int = Field(ge=1)
    automation: ProjectAutomationCreate
    workflow_definition: ProjectWorkflowDefinition


class ProjectAutomationView(ProjectChatSchema):
    id: str
    project_id: str
    name: str
    prompt: str
    trigger_type: Literal["manual", "schedule", "event", "workflow"]
    event_type: AutomationEventType | None
    event_config: dict[str, Any]
    cron_expression: str | None
    timezone: str
    execution_device_id: str | None
    target_kind: AutomationTargetKind
    target_id: str
    target_name: str
    enabled: bool
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_run_status: AutomationRunStatus | None
    version: int
    created_at: datetime
    updated_at: datetime


class ProjectAutomationWorkflowMigrationView(ProjectChatSchema):
    """Result of promoting one legacy workflow into automation storage."""

    automation: ProjectAutomationView
    project_version: int
    workflow_automation_id: str


class ProjectAutomationDeleteView(ProjectChatSchema):
    """Project state after deleting one automation."""

    project_version: int
    workflow_automation_id: str | None


class ProjectAutomationRunView(ProjectChatSchema):
    id: str
    automation_id: str
    project_id: str
    trigger: Literal["scheduled", "manual", "event"]
    status: AutomationRunStatus
    timezone: str
    scheduled_for: datetime
    expires_at: datetime | None
    task_id: str | None
    task_title: str | None = None
    backend_task_id: int | None = None
    device_id: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    retryable: bool = False
    trigger_type: Literal["schedule", "event", "workflow"] | None = None
    event_type: AutomationEventType | None = None
    event_config: dict[str, Any] | None = None
