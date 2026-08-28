# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wire contracts for reusable Wework Runtime profiles."""

from typing import Any, Literal

from pydantic import ConfigDict, Field, model_validator

from app.schemas.project_chat import ProjectChatSchema

RuntimeEnvironment = Literal["local", "cloud"]
RuntimeWorkspacePolicy = Literal["project", "git_worktree"]


class RuntimeProfileCreate(ProjectChatSchema):
    name: str = Field(min_length=1, max_length=100)
    execution_environment: RuntimeEnvironment
    execution_device_id: str = Field(min_length=1, max_length=100)
    model: str = Field(default="", max_length=255)
    model_type: Literal["public", "user", "group", "runtime"] | None = None
    model_options: dict[str, str] = Field(default_factory=dict)
    workspace_policy: RuntimeWorkspacePolicy = "project"


class RuntimeProfileUpdate(ProjectChatSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    execution_environment: RuntimeEnvironment | None = None
    execution_device_id: str | None = Field(default=None, min_length=1, max_length=100)
    model: str | None = Field(default=None, min_length=1, max_length=255)
    model_type: Literal["public", "user", "group", "runtime"] | None = None
    model_options: dict[str, str] | None = None
    workspace_policy: RuntimeWorkspacePolicy | None = None
    status: Literal["active", "archived"] | None = None


class RuntimeProfileView(ProjectChatSchema):
    id: str
    name: str
    execution_environment: RuntimeEnvironment
    execution_device_id: str
    model: str
    model_type: Literal["public", "user", "group", "runtime"] | None
    model_options: dict[str, str]
    workspace_policy: RuntimeWorkspacePolicy
    status: Literal["active", "archived"]
    version: int
    created_at: Any
    updated_at: Any


class ProjectRuntimeDefaultUpdate(ProjectChatSchema):
    runtime_profile_id: str = Field(min_length=1, max_length=64)


class ProjectRuntimeDefaultView(ProjectChatSchema):
    project_id: str
    user_id: int
    runtime_profile_id: str | None


class ExecutionRuntimeSelect(ProjectChatSchema):
    runtime_profile_id: str = Field(min_length=1, max_length=64)
    version: int = Field(ge=1)

    model_config = ConfigDict(
        alias_generator=lambda value: value.split("_")[0]
        + "".join(part.capitalize() for part in value.split("_")[1:]),
        populate_by_name=True,
        extra="forbid",
    )

    @model_validator(mode="after")
    def validate_profile(self) -> "ExecutionRuntimeSelect":
        if not self.runtime_profile_id.strip():
            raise ValueError("runtime_profile_id cannot be empty")
        return self
