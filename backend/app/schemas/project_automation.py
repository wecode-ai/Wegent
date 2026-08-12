# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for project-scoped scheduled automations."""

from datetime import datetime
from typing import Literal

from pydantic import Field

from app.schemas.project_chat import ProjectChatSchema

AutomationRunStatus = Literal[
    "pending",
    "waiting_device",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
]


class ProjectAutomationCreate(ProjectChatSchema):
    name: str = Field(min_length=1, max_length=255)
    prompt: str = Field(min_length=1, max_length=100_000)
    cron_expression: str = Field(min_length=1, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    agent_id: str = Field(min_length=1, max_length=64)
    enabled: bool = True


class ProjectAutomationUpdate(ProjectChatSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=255)
    prompt: str | None = Field(default=None, min_length=1, max_length=100_000)
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    agent_id: str | None = Field(default=None, min_length=1, max_length=64)
    enabled: bool | None = None


class ProjectAutomationView(ProjectChatSchema):
    id: str
    project_id: str
    name: str
    prompt: str
    cron_expression: str
    timezone: str
    agent_id: str
    agent_name: str
    execution_environment: str
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
    trigger: Literal["scheduled", "manual"]
    status: AutomationRunStatus
    timezone: str
    scheduled_for: datetime
    expires_at: datetime | None
    task_id: str | None
    device_id: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime
