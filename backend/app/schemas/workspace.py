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


class CollaborationGroupPolicy(BaseModel):
    prompt: str = Field(default="", max_length=100_000)
    trigger_type: Literal["manual", "schedule", "event"] = "manual"
    event_type: str | None = Field(default=None, min_length=1, max_length=100)
    event_config: dict[str, object] = Field(default_factory=dict)
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    issue_selector: dict[str, object] = Field(default_factory=dict)
    output_policy: dict[str, object] = Field(default_factory=dict)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_trigger(self) -> "CollaborationGroupPolicy":
        if self.trigger_type == "schedule" and not self.cron_expression:
            raise ValueError("Scheduled collaboration requires cron_expression")
        if self.trigger_type == "event" and not self.event_type:
            raise ValueError("Event collaboration requires event_type")
        if self.trigger_type != "schedule" and self.cron_expression:
            raise ValueError(
                "cron_expression is only valid for scheduled collaboration"
            )
        if self.trigger_type != "event" and (self.event_type or self.event_config):
            raise ValueError(
                "event configuration is only valid for event collaboration"
            )
        return self


class CollaborationGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=20_000)
    leader: CollaborationGroupMember
    members: list[CollaborationGroupMember] = Field(min_length=1)
    coordination_mode: Literal["manager"] = "manager"
    policy: CollaborationGroupPolicy = Field(default_factory=CollaborationGroupPolicy)

    @model_validator(mode="after")
    def validate_execution_policy(self) -> "CollaborationGroupCreate":
        if self.policy.trigger_type != "manual" and self.leader.kind != "agent":
            raise ValueError(
                "Scheduled and event collaboration requires an Agent leader"
            )
        return self


class CollaborationGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=20_000)
    leader: CollaborationGroupMember | None = None
    members: list[CollaborationGroupMember] | None = Field(default=None, min_length=1)
    coordination_mode: Literal["manager"] | None = None
    policy: CollaborationGroupPolicy | None = None
    version: int = Field(ge=1)

    @model_validator(mode="after")
    def require_change(self) -> "CollaborationGroupUpdate":
        if all(
            value is None
            for value in (
                self.name,
                self.description,
                self.leader,
                self.members,
                self.coordination_mode,
                self.policy,
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
    leader: CollaborationGroupMember
    members: list[CollaborationGroupMember]
    coordination_mode: Literal["manager"]
    policy: CollaborationGroupPolicy
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
