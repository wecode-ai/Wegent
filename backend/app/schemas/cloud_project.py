# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for shared cloud projects and local execution bindings."""

from datetime import datetime
from typing import Annotated

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from app.schemas.base_role import BaseRole
from app.schemas.tagging import MAX_TAGS_PER_ITEM, normalize_tags

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
    tags: list[str] | None = Field(default=None, max_length=MAX_TAGS_PER_ITEM)
    version: int = Field(ge=1)

    @field_validator("tags", mode="before")
    @classmethod
    def normalize_tag_list(cls, value: object) -> object:
        return None if value is None else normalize_tags(value)


class CloudProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    public_id: str
    project_key: str
    name: str
    description: str
    created_by_user_id: int
    status: str
    tags: list[str] = []
    version: int
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def populate_tags(cls, value: object) -> object:
        """Fill tags from the metadata JSON when the input has no tags key."""
        if isinstance(value, dict) and "tags" not in value:
            metadata = value.get("metadata_json")
            tags = metadata.get("tags") if isinstance(metadata, dict) else None
            return {**value, "tags": normalize_tags(tags)}
        return value


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

    @field_validator("device_id", mode="before")
    @classmethod
    def normalize_empty_device_id(cls, value: object) -> object:
        return None if value == "" else value


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
