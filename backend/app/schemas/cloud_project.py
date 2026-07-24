# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for shared cloud projects and local execution bindings."""

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

from app.schemas.base_role import BaseRole

SnowflakeId = Annotated[str, BeforeValidator(str)]


class CloudProjectCreate(BaseModel):
    project_key: str | None = Field(
        default=None, min_length=2, max_length=16, pattern=r"^[A-Za-z0-9]+$"
    )
    name: str = Field(min_length=1, max_length=100)
    description: str = ""

    @field_validator("project_key")
    @classmethod
    def normalize_project_key(cls, value: str | None) -> str | None:
        return value.upper() if value else None


class CloudProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    version: int = Field(ge=1)


class CloudProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    public_id: str
    project_key: str
    name: str
    description: str
    created_by_user_id: int
    status: str
    version: int
    created_at: datetime
    updated_at: datetime


class CloudProjectListResponse(BaseModel):
    items: list[CloudProjectResponse]


class LocalBindingCreate(BaseModel):
    local_project_id: int
    device_id: str | None = Field(default=None, max_length=100)
    is_default: bool = False


class LocalBindingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    cloud_project_id: SnowflakeId
    local_project_id: int
    user_id: int
    device_id: str | None
    is_default: bool
    created_at: datetime
    updated_at: datetime


class CloudProjectMemberCreate(BaseModel):
    user_id: int = Field(ge=1)
    role: BaseRole = BaseRole.Developer

    @field_validator("role")
    @classmethod
    def reject_owner(cls, value: BaseRole) -> BaseRole:
        if value == BaseRole.Owner:
            raise ValueError("Owner cannot be assigned")
        return value


class CloudProjectMemberUpdate(BaseModel):
    role: BaseRole

    @field_validator("role")
    @classmethod
    def reject_owner(cls, value: BaseRole) -> BaseRole:
        if value == BaseRole.Owner:
            raise ValueError("Owner cannot be assigned")
        return value


class CloudProjectMemberResponse(BaseModel):
    id: int
    user_id: int
    user_name: str
    email: str | None
    role: BaseRole
