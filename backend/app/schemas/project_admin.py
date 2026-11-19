# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project administration controls and the public audit result contract."""

from datetime import datetime
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.tagging import MAX_TAG_LENGTH, require_canonical_tag


class ProjectCollaborationPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(default="", max_length=200_000)
    revision: int = Field(default=1, ge=1)


class ProjectTagChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str = Field(min_length=1, max_length=MAX_TAG_LENGTH)
    target: str | None = Field(max_length=MAX_TAG_LENGTH)

    @field_validator("source", "target")
    @classmethod
    def validate_tag(cls, value: str | None) -> str | None:
        return None if value is None else require_canonical_tag(value)


class ProjectAdminActor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    userId: int


class ProjectMemberChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: Literal["add", "update", "remove_direct"]
    user_id: int = Field(ge=1)
    permission_role: Literal["Maintainer", "Developer", "Viewer"] | None = None
    capability_description: str | None = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def validate_operation(self) -> "ProjectMemberChange":
        if self.operation == "add" and self.permission_role is None:
            raise ValueError("add requires a permission_role")
        if self.operation == "remove_direct" and (
            self.permission_role is not None or self.capability_description is not None
        ):
            raise ValueError(
                "remove_direct does not accept role or responsibility changes"
            )
        if self.operation == "update" and (
            self.permission_role is None and self.capability_description is None
        ):
            raise ValueError(
                "update requires a permission role or functional responsibility"
            )
        return self


class ProjectAssistantRosterChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent_id: str = Field(min_length=1, max_length=64)
    agent_version: int = Field(ge=1)
    status: Literal["active", "archived"] | None = None
    capability_description: str | None = Field(default=None, max_length=2_000)
    wegent_team_id: int | None = Field(default=None, ge=1)
    execution_device_id: str | None = Field(default=None, min_length=1, max_length=128)
    default_runtime_profile_id: str | None = Field(
        default=None, min_length=1, max_length=128
    )

    @model_validator(mode="after")
    def require_change(self) -> "ProjectAssistantRosterChange":
        binding_fields = {
            "wegent_team_id",
            "execution_device_id",
            "default_runtime_profile_id",
        }
        if (
            self.status is None
            and self.capability_description is None
            and not self.model_fields_set & binding_fields
        ):
            raise ValueError(
                "assistant roster update requires status, responsibility, or an existing binding"
            )
        return self


RosterChange = TypeVar("RosterChange", bound=BaseModel)


def validate_unique_roster_changes(
    values: list[RosterChange], field: str
) -> list[RosterChange]:
    identities = [getattr(value, field) for value in values]
    if len(identities) != len(set(identities)):
        raise ValueError("A roster member may be changed only once per operation")
    return values


class ProjectAdminFieldChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    before: Any = None
    after: Any = None


class ProjectAdminReadResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projectVersion: int = Field(ge=1)
    revision: int = Field(ge=1)
    configuration: dict[str, Any]


class ProjectAdminWriteResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projectVersion: int = Field(ge=1)
    revision: int = Field(ge=1)
    before: dict[str, Any]
    after: dict[str, Any]
    diff: list[ProjectAdminFieldChange]
    actor: ProjectAdminActor
    operationId: str
    appliedAt: datetime | None = None
    auditId: str | None = None
    dryRun: bool = False
    effectScope: Literal["future_issues"] | None = None
    runningIssueSnapshotRule: Literal["preserved"] | None = None
