# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for collaboration Workspaces and shared capabilities."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.base_role import BaseRole
from app.schemas.types import SnowflakeId

ResourceOwnerType = Literal["user", "workspace"]


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=20_000)
    is_default: bool = False


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=20_000)
    is_default: bool | None = None
    version: int = Field(ge=1)

    @model_validator(mode="after")
    def require_change(self) -> "WorkspaceUpdate":
        if self.name is None and self.description is None and self.is_default is None:
            raise ValueError("Workspace update must change at least one field")
        return self


class WorkspaceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    public_id: str
    name: str
    description: str
    created_by_user_id: int
    access_role: BaseRole = BaseRole.Reporter
    member_count: int = 0
    project_count: int = 0
    agent_count: int = 0
    execution_environment_count: int = 0
    is_default: bool
    status: Literal["active", "archived"]
    version: int
    created_at: datetime
    updated_at: datetime


class WorkspaceListResponse(BaseModel):
    items: list[WorkspaceResponse]


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
    name: str
    kind: Literal["local_device", "cloud_host"]
    owner_type: Literal["user"] = "user"
    owner_id: str
    owner_name: str
    status: Literal["online", "offline", "provisioning", "error"]
    workspace_ids: list[str] = Field(default_factory=list)
    updated_at: datetime


class PersonalResourcesResponse(BaseModel):
    agents: list[PersonalAgentResource]
    execution_environments: list[PersonalExecutionEnvironmentResource]
