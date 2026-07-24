# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API schemas for project TODO delivery snapshots."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.cloud_project import CloudProjectResponse, SnowflakeId


class LoopItemCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str = ""
    status: Literal["inbox", "pending", "in_progress", "in_review", "completed"] = (
        "inbox"
    )
    assignee_user_id: int | None = None
    priority: Literal["none", "low", "medium", "high", "urgent"] = "none"
    due_at: datetime | None = None
    parent_id: str | None = Field(default=None, max_length=64)


class LoopItemUpdate(BaseModel):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    status: (
        Literal["inbox", "pending", "in_progress", "in_review", "completed"] | None
    ) = None
    assignee_user_id: int | None = None
    priority: Literal["none", "low", "medium", "high", "urgent"] | None = None
    due_at: datetime | None = None
    parent_id: str | None = Field(default=None, max_length=64)


class LoopItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    cloud_project_id: SnowflakeId
    sequence_number: int
    parent_id: str | None
    title: str
    description: str
    status: str
    assignee_user_id: int | None
    priority: str
    due_at: datetime | None
    sort_order: int
    created_by_user_id: int
    current_delivery_id: str | None
    version: int
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None

    @field_validator("parent_id", "current_delivery_id", mode="before")
    @classmethod
    def normalize_empty_id(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("assignee_user_id", mode="before")
    @classmethod
    def normalize_empty_user_id(cls, value: object) -> object:
        return None if value == 0 else value

    @field_validator("due_at", "completed_at", mode="before")
    @classmethod
    def normalize_unset_datetime(cls, value: object) -> object:
        if isinstance(value, datetime) and value == datetime(1970, 1, 1, 0, 0, 1):
            return None
        if isinstance(value, str) and value.startswith("1970-01-01 00:00:01"):
            return None
        return value


class LoopItemListResponse(BaseModel):
    items: list[LoopItemResponse]


class LoopItemAttachmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    loop_item_id: str
    display_name: str
    content_type: str | None
    size_bytes: int
    sha256: str
    created_by_user_id: int
    created_at: datetime

    @field_validator("content_type", mode="before")
    @classmethod
    def normalize_empty_content_type(cls, value: object) -> object:
        return None if value == "" else value


class LoopItemAttachmentAccessResponse(BaseModel):
    url: str
    expires_in_seconds: int


class MyWorkItemResponse(LoopItemResponse):
    project_key: str
    project_name: str
    has_active_task: bool


class MyWorkListResponse(BaseModel):
    items: list[MyWorkItemResponse]


class LoopItemCollaboratorCreate(BaseModel):
    user_id: int = Field(ge=1)


class LoopItemCollaboratorResponse(BaseModel):
    id: SnowflakeId
    loop_item_id: str
    user_id: int
    user_name: str
    email: str | None
    source: str
    added_by_user_id: int
    created_at: datetime


class LoopItemTaskBind(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    device_id: str = Field(alias="deviceId", min_length=1, max_length=100)
    task_id: str = Field(alias="taskId", min_length=1, max_length=255)
    task_title: str | None = Field(default=None, alias="taskTitle", max_length=255)
    backend_task_id: int | None = Field(default=None, alias="backendTaskId")


class LoopItemTaskBindingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    cloud_project_id: SnowflakeId
    loop_item_id: str | None
    task_user_id: int
    device_id: str
    task_id: str
    task_title: str | None
    backend_task_id: int | None
    linked_by_user_id: int
    linked_at: datetime
    unlinked_at: datetime | None

    @field_validator("loop_item_id", "task_title", mode="before")
    @classmethod
    def normalize_empty_text(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("backend_task_id", mode="before")
    @classmethod
    def normalize_empty_task_id(cls, value: object) -> object:
        return None if value == 0 else value

    @field_validator("unlinked_at", mode="before")
    @classmethod
    def normalize_unlinked_at(cls, value: object) -> object:
        return LoopItemResponse.normalize_unset_datetime(value)


class CloudTaskContextResponse(LoopItemTaskBindingResponse):
    project: CloudProjectResponse
    loop_item: LoopItemResponse | None = None


class DeliveryCreate(BaseModel):
    markdown: str = ""
    chat: dict[str, Any] | None = None
    source_task: LoopItemTaskBind | None = None


class DeliveryAssetResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    kind: str
    display_name: str
    relative_path: str = Field(max_length=700)
    content_type: str | None
    size_bytes: int
    sha256: str

    @field_validator("content_type", mode="before")
    @classmethod
    def normalize_empty_content_type(cls, value: object) -> object:
        return None if value == "" else value


class DeliveryAssetAccessResponse(BaseModel):
    url: str
    expires_in_seconds: int = 900


class DeliveryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    loop_item_id: str
    created_by_user_id: int
    source_task_binding_id: int | None
    source_task_snapshot: dict[str, Any] | None
    status: Literal["draft", "delivered"]
    created_at: datetime
    delivered_at: datetime | None
    assets: list[DeliveryAssetResponse] = Field(default_factory=list)

    @field_validator("source_task_binding_id", mode="before")
    @classmethod
    def normalize_empty_binding_id(cls, value: object) -> object:
        return None if value in ("", 0) else value

    @field_validator("source_task_snapshot", mode="before")
    @classmethod
    def normalize_empty_snapshot(cls, value: object) -> object:
        return None if value == {} else value

    @field_validator("delivered_at", mode="before")
    @classmethod
    def normalize_delivered_at(cls, value: object) -> object:
        return LoopItemResponse.normalize_unset_datetime(value)


class DeliveryDetailResponse(DeliveryResponse):
    markdown: str
    chat: dict[str, Any] | None = None


class DeliveryListResponse(BaseModel):
    items: list[DeliveryResponse]
