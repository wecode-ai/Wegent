# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API schemas for project TODO delivery snapshots."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

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


class DeliveryDetailResponse(DeliveryResponse):
    markdown: str
    chat: dict[str, Any] | None = None


class DeliveryListResponse(BaseModel):
    items: list[DeliveryResponse]
