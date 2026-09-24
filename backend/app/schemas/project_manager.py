# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project-level AI manager configuration and approval contracts."""

from typing import Literal

from pydantic import Field, model_validator

from app.schemas.project_automation import ProjectAutomationRunView
from app.schemas.project_chat import ProjectChatSchema
from app.schemas.runtime_work import RuntimeModelSelection


class ProjectManagerTrigger(ProjectChatSchema):
    id: str = Field(min_length=1, max_length=64)
    kind: Literal["event", "schedule"]
    event_type: (
        Literal["task.created", "task.tag_added", "task.status_changed"] | None
    ) = None
    tags: list[str] = Field(default_factory=list)
    cron_expression: str | None = Field(default=None, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_trigger(self) -> "ProjectManagerTrigger":
        if self.kind == "event" and (not self.event_type or self.cron_expression):
            raise ValueError("Event trigger requires only event_type")
        if self.kind == "schedule" and (not self.cron_expression or self.event_type):
            raise ValueError("Schedule trigger requires only cron_expression")
        if len(set(self.tags)) != len(self.tags):
            raise ValueError("Trigger tags must be unique")
        return self


class ProjectManagerConfig(ProjectChatSchema):
    version: int = Field(ge=1)
    enabled: bool = False
    agent_id: str = ""
    prompt: str = Field(default="", max_length=100_000)
    triggers: list[ProjectManagerTrigger] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_configuration(self) -> "ProjectManagerConfig":
        if self.enabled and (not self.agent_id or not self.prompt.strip()):
            raise ValueError(
                "Enabled project manager requires an Agent and instructions"
            )
        ids = [trigger.id for trigger in self.triggers]
        if len(ids) != len(set(ids)):
            raise ValueError("Project manager trigger IDs must be unique")
        return self


class ProjectManagerConfigView(ProjectManagerConfig):
    project_id: str


class ProjectManagerInstruction(ProjectChatSchema):
    message: str = Field(min_length=1, max_length=100_000)
    model_selection: RuntimeModelSelection | None = None


class ProjectManagerDecision(ProjectChatSchema):
    approve: bool
    version: int = Field(ge=1)


class ProjectManagerActionView(ProjectChatSchema):
    id: str
    kind: str
    item_id: str
    item_version: int | None = None
    approver_user_id: int | None = None
    status: Literal["executed", "pending_confirmation", "rejected"]
    payload: dict | None = None
    before: dict | None = None
    after: dict | None = None
    created_at: str
    decided_by_user_id: int | None = None
    decided_at: str | None = None


class ProjectManagerRunView(ProjectAutomationRunView):
    trigger_type: Literal["manual", "schedule", "event", "workflow"] | None = None
    instruction: str | None = None
    execution_url: str | None = None


class ProjectManagerRunDetail(ProjectManagerRunView):
    actions: list[ProjectManagerActionView] = Field(default_factory=list)
    response: str | None = None
