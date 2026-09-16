# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for collaboration Workspaces and shared capabilities."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.base_role import BaseRole
from app.schemas.types import SnowflakeId

ResourceOwnerType = Literal["user", "workspace"]


class ExecutionEnvironmentRepository(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=2_000)
    ref: str = Field(default="", max_length=255)
    path: str = Field(min_length=1, max_length=500)
    primary: bool = False

    @field_validator("name", "url", "ref", "path")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("path")
    @classmethod
    def require_relative_path(cls, value: str) -> str:
        parts = value.replace("\\", "/").split("/")
        if value.startswith(("/", "\\")) or any(
            part in {"", ".", ".."} for part in parts
        ):
            raise ValueError("repository path must be a normalized relative path")
        return "/".join(parts)


class ExecutionEnvironmentSetupStep(BaseModel):
    command: str = Field(min_length=1, max_length=2_000)
    working_directory: str = Field(default="", max_length=500)

    @field_validator("command", "working_directory")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("working_directory")
    @classmethod
    def require_relative_working_directory(cls, value: str) -> str:
        if not value:
            return value
        parts = value.replace("\\", "/").split("/")
        if value.startswith(("/", "\\")) or any(
            part in {"", ".", ".."} for part in parts
        ):
            raise ValueError("working directory must be a normalized relative path")
        return "/".join(parts)


class ExecutionEnvironmentDefinition(BaseModel):
    repositories: list[ExecutionEnvironmentRepository] = Field(
        default_factory=list, max_length=20
    )
    setup_steps: list[ExecutionEnvironmentSetupStep] = Field(
        default_factory=list, max_length=50
    )

    @model_validator(mode="after")
    def validate_repositories(self) -> "ExecutionEnvironmentDefinition":
        if self.repositories:
            primary_count = sum(repository.primary for repository in self.repositories)
            if primary_count != 1:
                raise ValueError(
                    "execution environment must have exactly one primary repository"
                )
        names = [repository.name for repository in self.repositories]
        paths = [repository.path for repository in self.repositories]
        if len(names) != len(set(names)):
            raise ValueError("repository names must be unique")
        if len(paths) != len(set(paths)):
            raise ValueError("repository paths must be unique")
        if any(
            left != right
            and (left.startswith(f"{right}/") or right.startswith(f"{left}/"))
            for index, left in enumerate(paths)
            for right in paths[index + 1 :]
        ):
            raise ValueError("repository paths must not overlap")
        for step in self.setup_steps:
            working_directory = step.working_directory
            if working_directory and not any(
                working_directory == path or working_directory.startswith(f"{path}/")
                for path in paths
            ):
                raise ValueError(
                    "setup working directory must be inside a configured repository"
                )
        return self


class ExecutionEnvironmentConfig(ExecutionEnvironmentDefinition):
    status: Literal["uninitialized", "preparing", "ready", "error"] = "uninitialized"
    fingerprint: str = ""
    prepared_device_id: str = ""
    prepared_workspace_path: str = ""
    prepared_at: datetime | None = None
    error: str = ""


class ExecutionEnvironmentInitialize(BaseModel):
    device_id: int = Field(ge=1)
    version: int = Field(ge=1)


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=20_000)
    namespace: str = Field(default="default", min_length=1, max_length=100)
    is_default: bool = False


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=20_000)
    is_default: bool | None = None
    execution_environment: ExecutionEnvironmentDefinition | None = None
    version: int = Field(ge=1)

    @model_validator(mode="after")
    def require_change(self) -> "WorkspaceUpdate":
        if (
            self.name is None
            and self.description is None
            and self.is_default is None
            and self.execution_environment is None
        ):
            raise ValueError("Workspace update must change at least one field")
        return self


class WorkspaceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    public_id: str
    name: str
    description: str
    namespace: str
    created_by_user_id: int
    access_role: BaseRole = BaseRole.Reporter
    member_count: int = 0
    project_count: int = 0
    agent_count: int = 0
    execution_environment_count: int = 0
    execution_environment: ExecutionEnvironmentConfig = Field(
        default_factory=ExecutionEnvironmentConfig
    )
    is_default: bool
    status: Literal["active", "archived"]
    version: int
    created_at: datetime
    updated_at: datetime


class WorkspaceListResponse(BaseModel):
    items: list[WorkspaceResponse]


class WorkspaceNavigationContextResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    public_id: str
    name: str


class WorkspaceMemberCreate(BaseModel):
    user_id: int = Field(ge=1)
    role: BaseRole = BaseRole.Developer

    @model_validator(mode="after")
    def reject_owner(self) -> "WorkspaceMemberCreate":
        if self.role == BaseRole.Owner:
            raise ValueError("Owner cannot be assigned")
        return self


class WorkspaceMemberUpdate(BaseModel):
    role: BaseRole

    @model_validator(mode="after")
    def reject_owner(self) -> "WorkspaceMemberUpdate":
        if self.role == BaseRole.Owner:
            raise ValueError("Owner cannot be assigned")
        return self


class WorkspaceMemberResponse(BaseModel):
    id: int
    user_id: int
    user_name: str
    email: str | None
    role: BaseRole


class WorkspaceMemberListResponse(BaseModel):
    items: list[WorkspaceMemberResponse]


class WorkspaceAgentCreate(BaseModel):
    team_id: int = Field(ge=1)


class WorkspaceAgentResponse(BaseModel):
    id: SnowflakeId
    workspace_id: SnowflakeId
    team_id: int
    name: str
    namespace: str
    owner_type: ResourceOwnerType
    owner_id: SnowflakeId
    owner_name: str
    status: Literal["available", "unavailable"]
    execution_environment_ids: list[str] = Field(default_factory=list)
    owner_user_id: int | None
    added_by_user_id: int
    created_at: datetime
    updated_at: datetime


class WorkspaceAgentListResponse(BaseModel):
    items: list[WorkspaceAgentResponse]


class CollaborationGroupMember(BaseModel):
    kind: Literal["human", "agent"]
    id: SnowflakeId
    responsibility: str = Field(default="", max_length=2_000)


class CollaborationGroupStage(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=20_000)
    assignee: CollaborationGroupMember | None = None


class CollaborationGroupExecutionRequirements(BaseModel):
    required_tags: list[str] = Field(default_factory=list, max_length=50)


class CollaborationGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=20_000)
    instructions: str = Field(default="", max_length=50_000)
    leader: CollaborationGroupMember
    members: list[CollaborationGroupMember] = Field(min_length=1)
    coordination_mode: Literal["manager"] = "manager"
    stages: list[CollaborationGroupStage] = Field(default_factory=list, max_length=50)
    execution_requirements: CollaborationGroupExecutionRequirements = Field(
        default_factory=CollaborationGroupExecutionRequirements
    )


class CollaborationGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=20_000)
    instructions: str | None = Field(default=None, max_length=50_000)
    leader: CollaborationGroupMember | None = None
    members: list[CollaborationGroupMember] | None = Field(default=None, min_length=1)
    coordination_mode: Literal["manager"] | None = None
    stages: list[CollaborationGroupStage] | None = Field(default=None, max_length=50)
    execution_requirements: CollaborationGroupExecutionRequirements | None = None
    version: int = Field(ge=1)

    @model_validator(mode="after")
    def require_change(self) -> "CollaborationGroupUpdate":
        if all(
            value is None
            for value in (
                self.name,
                self.description,
                self.instructions,
                self.leader,
                self.members,
                self.coordination_mode,
                self.stages,
                self.execution_requirements,
            )
        ):
            raise ValueError(
                "Collaboration group update must change at least one field"
            )
        return self


class CollaborationGroupResponse(BaseModel):
    id: SnowflakeId
    workspace_id: SnowflakeId
    owner_type: Literal["workspace", "project"]
    owner_id: SnowflakeId
    name: str
    description: str
    instructions: str
    leader: CollaborationGroupMember
    members: list[CollaborationGroupMember]
    coordination_mode: Literal["manager"]
    stages: list[CollaborationGroupStage]
    execution_requirements: CollaborationGroupExecutionRequirements
    version: int
    created_by_user_id: int
    created_at: datetime
    updated_at: datetime


class CollaborationGroupListResponse(BaseModel):
    items: list[CollaborationGroupResponse]


class WorkspaceExecutionEnvironmentCreate(BaseModel):
    device_id: int = Field(ge=1)


class WorkspaceExecutionEnvironmentResponse(BaseModel):
    id: SnowflakeId
    workspace_id: SnowflakeId
    device_id: int
    device_key: str
    name: str
    kind: Literal["local_device", "cloud_host"]
    device_type: str
    runtime_instance_id: str | None
    capabilities: list[str]
    coding_tools: list[str] = Field(default_factory=list)
    owner_type: ResourceOwnerType
    owner_id: SnowflakeId
    owner_name: str
    status: Literal["online", "offline", "provisioning", "error"]
    owner_user_id: int | None
    added_by_user_id: int
    created_at: datetime
    updated_at: datetime


class WorkspaceExecutionEnvironmentListResponse(BaseModel):
    items: list[WorkspaceExecutionEnvironmentResponse]


class PersonalAgentResource(BaseModel):
    id: SnowflakeId
    name: str
    team_id: int
    owner_type: Literal["user"] = "user"
    owner_id: str
    owner_name: str
    status: Literal["available", "unavailable"]
    execution_environment_ids: list[str] = Field(default_factory=list)
    workspace_ids: list[str] = Field(default_factory=list)


class PersonalExecutionEnvironmentResource(BaseModel):
    id: SnowflakeId
    device_id: int
    device_key: str
    name: str
    kind: Literal["local_device", "cloud_host"]
    coding_tools: list[str] = Field(default_factory=list)
    owner_type: Literal["user"] = "user"
    owner_id: str
    owner_name: str
    status: Literal["online", "offline", "provisioning", "error"]
    workspace_ids: list[str] = Field(default_factory=list)
    updated_at: datetime


class PersonalResourcesResponse(BaseModel):
    agents: list[PersonalAgentResource]
    execution_environments: list[PersonalExecutionEnvironmentResource]
