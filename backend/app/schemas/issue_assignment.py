# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Commands for assigning an Issue to a working role."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class IssueExperienceAdoption(BaseModel):
    automation_id: str = Field(min_length=1, max_length=64)
    intent: str = Field(min_length=1, max_length=100_000)


class IssueAssignmentDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    request_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=0)
    action: Literal["assign_role", "assign_user", "execute", "complete"]
    node_id: str | None = Field(default=None, min_length=1, max_length=64)
    assignee_user_id: int | None = Field(default=None, ge=1)
    instruction: str = Field(default="", max_length=100_000)
    reason: str = Field(min_length=1, max_length=4000)

    @model_validator(mode="after")
    def validate_action(self) -> "IssueAssignmentDecision":
        if self.action == "assign_role" and not self.node_id:
            raise ValueError("Role assignment requires a node")
        if self.action == "assign_user" and not self.assignee_user_id:
            raise ValueError("Human assignment requires a project member")
        if self.action != "assign_user" and self.assignee_user_id is not None:
            raise ValueError("Only human assignment accepts a member")
        if self.action in {"execute", "complete"} and self.node_id is not None:
            raise ValueError("This action does not select a role")
        if self.action != "complete" and not self.instruction:
            raise ValueError("Assignment requires concrete work instructions")
        return self


class IssueAssignmentResult(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    assignment_id: str = Field(min_length=1, max_length=64)
    summary: str = Field(min_length=1, max_length=100_000)
