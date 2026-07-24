# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for files in a shared cloud project workspace."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.cloud_project import SnowflakeId


class CloudFolderCreate(BaseModel):
    path: str = Field(min_length=1, max_length=700)
    description: str = ""


class CloudFileMove(BaseModel):
    path: str = Field(min_length=1, max_length=700)
    version: int = Field(ge=1)


class CloudFileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    cloud_project_id: SnowflakeId
    path: str
    name: str
    kind: Literal["file", "folder"]
    content_type: str | None
    size_bytes: int
    sha256: str | None
    description: str
    created_by_user_id: int
    updated_by_user_id: int
    version: int
    created_at: datetime
    updated_at: datetime

    @field_validator("content_type", "sha256", mode="before")
    @classmethod
    def normalize_empty_optional_text(cls, value: object) -> object:
        return None if value == "" else value


class CloudFileListResponse(BaseModel):
    items: list[CloudFileResponse]


class ProjectDeliveryFileResponse(BaseModel):
    asset_id: str
    delivery_id: str
    loop_item_id: str
    loop_item_title: str
    relative_path: str
    display_name: str
    content_type: str | None
    size_bytes: int
    delivered_at: datetime


class ProjectDeliveryFileListResponse(BaseModel):
    items: list[ProjectDeliveryFileResponse]


class CloudFileAccessResponse(BaseModel):
    url: str
    expires_in_seconds: int = 900
