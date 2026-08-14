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
    "running",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
]
AutomationExecutorType = Literal["project_robot", "custom", "wegent_robot"]


class ProjectAutomationExecutorSchema(ProjectChatSchema):
    """Strict public contract for one automation executor source."""

    model_config = ConfigDict(extra="forbid")


def _validate_executor_fields(
    *,
    executor_type: AutomationExecutorType,
    agent_id: str | None,
    wegent_team_id: int | None,
    model: str | None,
    execution_environment: Literal["local", "cloud"] | None,
    execution_device_id: str | None,
) -> None:
    if executor_type == "project_robot":
        if not agent_id:
            raise ValueError("agent_id is required for a project robot")
        if wegent_team_id is not None:
            raise ValueError("wegent_team_id is only valid for a Wegent robot")
        if model or execution_environment or execution_device_id:
            raise ValueError("inline AI configuration is only valid for custom AI")
        return
    if executor_type == "custom":
        if agent_id:
            raise ValueError("agent_id is only valid for a project robot")
        if wegent_team_id is not None:
            raise ValueError("wegent_team_id is only valid for a Wegent robot")
        if not model or not execution_environment or not execution_device_id:
            raise ValueError(
                "model, execution_environment, and execution_device_id are required "
                "for custom AI"
            )
        return
    if agent_id:
        raise ValueError("agent_id is only valid for a project robot")
    if wegent_team_id is None:
        raise ValueError("wegent_team_id is required for a Wegent robot")
    if model or execution_environment or execution_device_id:
        raise ValueError("inline AI configuration is only valid for custom AI")


class ProjectAutomationCreate(ProjectAutomationExecutorSchema):
    name: str = Field(min_length=1, max_length=255)
    prompt: str = Field(min_length=1, max_length=100_000)
    trigger_type: Literal["schedule", "event"] = "schedule"
    event_type: Literal["task.created"] | None = None
    event_config: dict[str, Any] = Field(default_factory=dict)
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    executor_type: AutomationExecutorType = "project_robot"
    agent_id: str | None = Field(default=None, min_length=1, max_length=64)
    wegent_team_id: int | None = Field(default=None, ge=1)
    model: str | None = Field(default=None, max_length=255)
    execution_environment: Literal["local", "cloud"] | None = None
    execution_device_id: str | None = Field(default=None, max_length=100)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_executor(self) -> Self:
        _validate_executor_fields(
            executor_type=self.executor_type,
            agent_id=self.agent_id,
            wegent_team_id=self.wegent_team_id,
            model=self.model,
            execution_environment=self.execution_environment,
            execution_device_id=self.execution_device_id,
        )
        return self


class ProjectAutomationUpdate(ProjectAutomationExecutorSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=255)
    prompt: str | None = Field(default=None, min_length=1, max_length=100_000)
    trigger_type: Literal["schedule", "event"] | None = None
    event_type: Literal["task.created"] | None = None
    event_config: dict[str, Any] | None = None
    executor_type: AutomationExecutorType | None = None
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    agent_id: str | None = Field(default=None, min_length=1, max_length=64)
    wegent_team_id: int | None = Field(default=None, ge=1)
    model: str | None = Field(default=None, max_length=255)
    execution_environment: Literal["local", "cloud"] | None = None
    execution_device_id: str | None = Field(default=None, max_length=100)
    enabled: bool | None = None

    @model_validator(mode="after")
    def validate_executor_switch(self) -> Self:
        executor_fields = {
            "agent_id",
            "wegent_team_id",
            "model",
            "execution_environment",
            "execution_device_id",
        }
        if self.executor_type is None:
            if executor_fields.intersection(self.model_fields_set):
                raise ValueError(
                    "executor_type is required when changing executor configuration"
                )
            return self
        _validate_executor_fields(
            executor_type=self.executor_type,
            agent_id=self.agent_id,
            wegent_team_id=self.wegent_team_id,
            model=self.model,
            execution_environment=self.execution_environment,
            execution_device_id=self.execution_device_id,
        )
        return self


class ProjectAutomationView(ProjectChatSchema):
    id: str
    project_id: str
    name: str
    prompt: str
    trigger_type: Literal["schedule", "event"]
    event_type: Literal["task.created"] | None
    event_config: dict[str, Any]
    executor_type: AutomationExecutorType
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
    backend_task_id: int | None = None
    device_id: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    trigger_type: Literal["schedule", "event"] | None = None
    event_type: Literal["task.created"] | None = None
    event_config: dict[str, Any] | None = None
