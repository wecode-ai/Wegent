"""Non-secret, device-owned declarations for personal Issue execution."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt


class AssistantProjectScope(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=64, strict=True)
    store: Literal["cloud", "local"]


class AssistantHandlingPolicy(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    automatic: StrictBool = False
    ask_before_act: StrictBool = Field(False, alias="askBeforeAct")


class AssistantProjectPolicy(AssistantProjectScope):
    policy: AssistantHandlingPolicy


class AssistantCollaborationScope(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    enabled: StrictBool = False
    all_projects: StrictBool = Field(False, alias="allProjects")
    projects: list[AssistantProjectScope] = Field(default_factory=list)
    excluded_projects: list[AssistantProjectScope] = Field(
        default_factory=list, alias="excludedProjects"
    )
    tags: list[str] = Field(default_factory=list)
    policy: AssistantHandlingPolicy | None = None
    project_policies: list[AssistantProjectPolicy] = Field(
        default_factory=list, alias="projectPolicies"
    )


class PersonalAssistantEndpoint(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: Literal["@primary"]
    user_id: StrictInt = Field(gt=0, alias="userId")
    enabled: StrictBool = False
    enabled_since: datetime | None = Field(None, alias="enabledSince")
    version: StrictInt = Field(default=0, ge=0)
    collaboration: AssistantCollaborationScope
    handling_policy: AssistantHandlingPolicy = Field(
        default_factory=AssistantHandlingPolicy, alias="handlingPolicy"
    )


class PersonalAssistantDispatchFeatures(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: StrictInt = Field(ge=1, le=1)
    roles: list[PersonalAssistantEndpoint] = Field(default_factory=list)
