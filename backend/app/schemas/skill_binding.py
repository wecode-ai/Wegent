# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for Skill bindings to long-term availability targets."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class SkillBindingTargetType(str, Enum):
    """Supported target types for SkillBinding resources."""

    USER = "user"
    AGENT = "agent"
    PROJECT = "project"
    MESSAGE = "message"


class SkillBindingExceptionType(str, Enum):
    """Supported automatic Skill exception dimensions."""

    MODE = "mode"
    AGENT = "agent"
    PROJECT = "project"


class SkillBindingException(BaseModel):
    """A context where an automatic Skill should not be injected."""

    type: SkillBindingExceptionType
    value: str = Field(min_length=1, max_length=128)


class SkillBindingSkillRef(BaseModel):
    """Reference to a Skill asset from a binding."""

    skill_id: int = Field(description="Kind.id of the Skill asset")
    name: str
    namespace: str
    is_public: bool = False


class SkillBindingSpec(BaseModel):
    """SkillBinding CRD spec."""

    skill_ref: SkillBindingSkillRef
    target_type: SkillBindingTargetType
    target_id: str
    created_by: int
    exceptions: list[SkillBindingException] = Field(default_factory=list)
    force_preload: bool = False


class SkillBindingUpdateRequest(BaseModel):
    """Request body for updating a user's automatic Skill settings."""

    exceptions: list[SkillBindingException] = Field(
        default_factory=list, max_length=200
    )
    force_preload: bool | None = None


class SkillBindingResponse(BaseModel):
    """API response for a SkillBinding resource."""

    id: int
    target_type: SkillBindingTargetType
    target_id: str
    skill_ref: SkillBindingSkillRef
    exceptions: list[SkillBindingException] = Field(default_factory=list)
    force_preload: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SkillAvailability(BaseModel):
    """Per-user availability flags for Skill library rows."""

    in_my_default: bool = False
    agent_builtin: bool = False
