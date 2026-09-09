# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Contracts for board event intake, clarification, and experience routing."""

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.project_chat import ProjectChatWorkspaceBinding


class EventCenterConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    runtime_profile_id: str | None = Field(default=None, max_length=64)
    workspace_binding: ProjectChatWorkspaceBinding = Field(
        default_factory=lambda: ProjectChatWorkspaceBinding(type="standalone")
    )
    instruction: str = Field(default="", max_length=4000)
    version: int = Field(default=1, ge=1)


class EventSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=255)
    content: str = Field(default="", max_length=65536)
    request_id: str = Field(min_length=1, max_length=128)


class EventReply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=16000)
    version: int = Field(ge=1)


class ExternalReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1, max_length=32)
    external_id: str = Field(min_length=1, max_length=512)
    url: str | None = Field(default=None, max_length=2048)


class ExperienceRole(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    instruction: str = Field(min_length=1, max_length=4000)


class ExperienceDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=4000)
    coordinator_prompt: str = Field(min_length=1, max_length=4000)
    roles: list[ExperienceRole] = Field(min_length=1, max_length=20)


class EventRoutingDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    action: Literal[
        "clarify", "route_existing", "start_workflow", "create_workflow", "ignore"
    ]
    reason: str = Field(min_length=1, max_length=4000)
    question: str | None = Field(default=None, max_length=4000)
    goal: str | None = Field(default=None, max_length=16000)
    issue_id: str | None = Field(default=None, max_length=64)
    automation_id: str | None = Field(default=None, max_length=64)
    workflow: ExperienceDraft | None = None

    @model_validator(mode="after")
    def validate_action(self) -> Self:
        required = {
            "clarify": self.question,
            "route_existing": self.issue_id,
            "start_workflow": self.automation_id and self.goal,
            "create_workflow": self.workflow and self.goal,
            "ignore": self.reason,
        }
        if not required[self.action]:
            raise ValueError(f"Incomplete {self.action} decision")
        allowed = {
            "clarify": {"question"},
            "route_existing": {"issue_id"},
            "start_workflow": {"automation_id", "goal", "issue_id"},
            "create_workflow": {"workflow", "goal", "issue_id"},
            "ignore": set(),
        }
        for field in {
            "question",
            "goal",
            "issue_id",
            "automation_id",
            "workflow",
        } - allowed[self.action]:
            if getattr(self, field) is not None:
                raise ValueError(f"{field} is not valid for {self.action}")
        return self
