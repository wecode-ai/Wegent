# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for shared cloud projects and local execution bindings."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from app.core.provider_credentials import mask_provider_config
from app.schemas.base_role import BaseRole
from app.schemas.tagging import MAX_TAGS_PER_ITEM, normalize_tags

SnowflakeId = Annotated[str, BeforeValidator(str)]
TaskProvider = Literal["local", "github", "gitlab"]


def _validate_provider_config(
    task_provider: TaskProvider, provider_config: dict[str, object]
) -> dict[str, object]:
    config = dict(provider_config)
    if task_provider == "local":
        return {}
    repository = config.get("repository")
    if not isinstance(repository, str) or not repository.strip():
        raise ValueError("provider_config.repository is required")
    config["repository"] = repository.strip()
    if "credential" in config:
        raise ValueError("encrypted provider credentials cannot be supplied")
    token = config.get("token")
    if token is not None and not isinstance(token, str):
        raise ValueError("provider token must be a string")
    if isinstance(token, str):
        config["token"] = token.strip()
    return config


class CloudProjectCreate(BaseModel):
    project_key: str | None = Field(
        default=None, min_length=2, max_length=16, pattern=r"^[A-Za-z0-9]+$"
    )
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    task_provider: TaskProvider = "local"
    provider_config: dict[str, object] = Field(default_factory=dict)

    @field_validator("project_key")
    @classmethod
    def normalize_project_key(cls, value: str | None) -> str | None:
        return value.upper() if value else None

    @model_validator(mode="after")
    def validate_provider(self) -> "CloudProjectCreate":
        self.provider_config = _validate_provider_config(
            self.task_provider, self.provider_config
        )
        return self


class CloudProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    tags: list[str] | None = Field(default=None, max_length=MAX_TAGS_PER_ITEM)
    provider_config: dict[str, object] | None = None
    version: int = Field(ge=1)

    @field_validator("tags", mode="before")
    @classmethod
    def normalize_tag_list(cls, value: object) -> object:
        return None if value is None else normalize_tags(value)

    @model_validator(mode="after")
    def validate_provider(self) -> "CloudProjectUpdate":
        if self.provider_config is not None:
            # The provider kind is immutable. The service validates this config
            # against the project's current provider before persisting it.
            if "credential" in self.provider_config:
                raise ValueError("encrypted provider credentials cannot be supplied")
            token = self.provider_config.get("token")
            if token is not None and not isinstance(token, str):
                raise ValueError("provider token must be a string")
            if isinstance(token, str):
                self.provider_config["token"] = token.strip()
        return self


class CloudProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    public_id: str
    project_key: str
    name: str
    description: str
    project_store: Literal["backend"] = "backend"
    task_provider: TaskProvider = "local"
    provider_config: dict[str, object] = Field(default_factory=dict)
    created_by_user_id: int
    status: str
    tags: list[str] = []
    version: int
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def populate_tags(cls, value: object) -> object:
        """Fill project routing fields from the metadata JSON."""
        if isinstance(value, dict):
            metadata = value.get("metadata_json")
            metadata = metadata if isinstance(metadata, dict) else {}
            return {
                **value,
                "project_store": "backend",
                "task_provider": metadata.get("task_provider", "local"),
                "provider_config": mask_provider_config(
                    metadata.get("provider_config", {})
                ),
                "tags": normalize_tags(metadata.get("tags")),
            }
        return value


class CloudProjectListResponse(BaseModel):
    items: list[CloudProjectResponse]


class CloudProjectProviderCredentialResponse(BaseModel):
    token: str


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
