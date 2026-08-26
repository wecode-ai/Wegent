# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for project-scoped scheduled automations."""

from datetime import datetime
from typing import Any, Literal, Self

from pydantic import ConfigDict, Field, model_validator

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
AutomationAssignmentMode = Literal["manual", "ai_managed"]
AutomationManagerType = Literal["custom", "wegent"]
AutomationRoleSource = Literal["generic", "agent"]
AutomationRuntimeSource = Literal[
    "agent_default",
    "fixed_profile",
    "issue_creator",
    "runtime_user",
]


class ProjectAutomationManagerAssign(ProjectChatSchema):
    """Assignment selected and applied by an authenticated AI manager."""

    model_config = ConfigDict(extra="forbid")

    assignee_type: Literal["user", "agent"]
    assignee_id: str = Field(min_length=1, max_length=128)


class ProjectAutomationAssignmentSchema(ProjectChatSchema):
    """Strict public contract for one automation assignment strategy."""

    model_config = ConfigDict(extra="forbid")


def _validate_assignment_fields(
    *,
    assignment_mode: AutomationAssignmentMode,
    manager_type: AutomationManagerType | None,
    agent_id: str | None,
    wegent_team_id: int | None,
    model: str | None,
    execution_environment: Literal["local", "cloud"] | None,
    execution_device_id: str | None,
    role_source: AutomationRoleSource = "agent",
) -> None:
    if assignment_mode == "manual":
        if role_source == "agent" and not agent_id:
            raise ValueError("agent_id is required for manual assignment")
        if role_source == "generic" and agent_id:
            raise ValueError("generic role does not accept agent_id")
        if manager_type is not None:
            raise ValueError("manager_type is only valid for AI-managed assignment")
        if wegent_team_id is not None:
            raise ValueError("wegent_team_id is only valid for a Wegent manager")
        if model or execution_environment or execution_device_id:
            raise ValueError("custom manager configuration requires AI management")
        return
    if agent_id:
        raise ValueError("agent_id is only valid for manual assignment")
    if manager_type == "custom":
        if wegent_team_id is not None:
            raise ValueError("wegent_team_id is only valid for a Wegent manager")
        if model or execution_environment or execution_device_id:
            raise ValueError("custom managers use a Runtime profile")
        return
    if manager_type == "wegent":
        if wegent_team_id is None:
            raise ValueError("wegent_team_id is required for a Wegent manager")
        if model or execution_environment or execution_device_id:
            raise ValueError("custom manager configuration is not valid for Wegent")
        return
    raise ValueError("manager_type is required for AI-managed assignment")


class ProjectAutomationCreate(ProjectAutomationAssignmentSchema):
    name: str = Field(min_length=1, max_length=255)
    prompt: str = Field(min_length=1, max_length=100_000)
    trigger_type: Literal["schedule", "event", "workflow"] = "schedule"
    event_type: Literal["task.created"] | None = None
    event_config: dict[str, Any] = Field(default_factory=dict)
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    assignment_mode: AutomationAssignmentMode = "manual"
    manager_type: AutomationManagerType | None = None
    agent_id: str | None = Field(default=None, min_length=1, max_length=64)
    wegent_team_id: int | None = Field(default=None, ge=1)
    model: str | None = Field(default=None, max_length=255)
    execution_environment: Literal["local", "cloud"] | None = None
    execution_device_id: str | None = Field(default=None, max_length=100)
    enabled: bool = True
    role_source: AutomationRoleSource = "agent"
    runtime_source: AutomationRuntimeSource = "agent_default"
    runtime_profile_id: str | None = Field(default=None, max_length=64)
    runtime_user_id: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_assignment(self) -> Self:
        _validate_assignment_fields(
            assignment_mode=self.assignment_mode,
            manager_type=self.manager_type,
            agent_id=self.agent_id,
            wegent_team_id=self.wegent_team_id,
            model=self.model,
            execution_environment=self.execution_environment,
            execution_device_id=self.execution_device_id,
            role_source=self.role_source,
        )
        self._validate_runtime()
        return self

    def _validate_runtime(self) -> None:
        if self.assignment_mode == "ai_managed" and self.manager_type == "wegent":
            if (
                self.runtime_source != "agent_default"
                or self.runtime_profile_id
                or self.runtime_user_id
            ):
                raise ValueError("Wegent managers use managed Runtime")
            return
        if self.role_source == "agent" and self.assignment_mode == "manual":
            if not self.agent_id:
                raise ValueError("agent role requires agent_id")
        elif self.assignment_mode == "manual" and self.agent_id:
            raise ValueError("generic role does not accept agent_id")
        if self.runtime_source == "agent_default":
            if self.assignment_mode == "manual" and self.role_source != "agent":
                raise ValueError("agent_default requires an agent role")
        elif self.runtime_source == "fixed_profile":
            if not self.runtime_profile_id:
                raise ValueError("fixed_profile requires runtime_profile_id")
        elif self.runtime_source == "runtime_user":
            if self.runtime_user_id is None:
                raise ValueError("runtime_user requires runtime_user_id")
        elif self.trigger_type == "schedule":
            raise ValueError("scheduled automation cannot use issue_creator Runtime")


class ProjectAutomationUpdate(ProjectAutomationAssignmentSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=255)
    prompt: str | None = Field(default=None, min_length=1, max_length=100_000)
    trigger_type: Literal["schedule", "event", "workflow"] | None = None
    event_type: Literal["task.created"] | None = None
    event_config: dict[str, Any] | None = None
    assignment_mode: AutomationAssignmentMode | None = None
    manager_type: AutomationManagerType | None = None
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    agent_id: str | None = Field(default=None, min_length=1, max_length=64)
    wegent_team_id: int | None = Field(default=None, ge=1)
    model: str | None = Field(default=None, max_length=255)
    execution_environment: Literal["local", "cloud"] | None = None
    execution_device_id: str | None = Field(default=None, max_length=100)
    enabled: bool | None = None
    role_source: AutomationRoleSource | None = None
    runtime_source: AutomationRuntimeSource | None = None
    runtime_profile_id: str | None = Field(default=None, max_length=64)
    runtime_user_id: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_assignment_switch(self) -> Self:
        assignment_fields = {
            "manager_type",
            "agent_id",
            "wegent_team_id",
            "model",
            "execution_environment",
            "execution_device_id",
        }
        if self.assignment_mode is None:
            if assignment_fields.intersection(self.model_fields_set):
                raise ValueError(
                    "assignment_mode is required when changing assignment configuration"
                )
            return self
        _validate_assignment_fields(
            assignment_mode=self.assignment_mode,
            manager_type=self.manager_type,
            agent_id=self.agent_id,
            wegent_team_id=self.wegent_team_id,
            model=self.model,
            execution_environment=self.execution_environment,
            execution_device_id=self.execution_device_id,
            role_source=self.role_source or "agent",
        )
        return self


class ProjectAutomationView(ProjectChatSchema):
    id: str
    project_id: str
    name: str
    prompt: str
    trigger_type: Literal["schedule", "event", "workflow"]
    event_type: Literal["task.created"] | None
    event_config: dict[str, Any]
    assignment_mode: AutomationAssignmentMode
    manager_type: AutomationManagerType | None
    webhook_event_id: str | None
    webhook_secret: str | None = None
    cron_expression: str | None
    timezone: str
    agent_id: str | None
    wegent_team_id: int | None = None
    model: str | None
    agent_name: str
    execution_environment: Literal["local", "cloud", "managed"]
    execution_device_id: str | None
    role_source: AutomationRoleSource = "agent"
    runtime_source: AutomationRuntimeSource = "agent_default"
    runtime_profile_id: str | None = None
    runtime_user_id: int | None = None
    enabled: bool
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_run_status: AutomationRunStatus | None
    version: int
    created_at: datetime
    updated_at: datetime


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
    event_type: Literal["task.created"] | None = None
    event_config: dict[str, Any] | None = None
