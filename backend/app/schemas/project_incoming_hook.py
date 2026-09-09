# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for project event subscriptions and incoming events."""

from datetime import datetime
from typing import Any, Literal, Self

from pydantic import Field, field_validator, model_validator

from app.schemas.project_chat import ProjectChatSchema

IncomingHookStatus = Literal["active", "disabled"]
EventSourceType = Literal["github", "gitlab", "wework", "generic"]
EventCollectionMode = Literal["webhook", "poll", "internal", "hybrid"]


class ObservedResource(ProjectChatSchema):
    resource_type: str | None = Field(default=None, max_length=64)
    instance_url: str | None = Field(default=None, max_length=500)
    external_id: str | None = Field(default=None, max_length=500)
    path: str | None = Field(default=None, max_length=1000)
    url: str | None = Field(default=None, max_length=2000)
    display_name: str | None = Field(default=None, max_length=255)


class ProjectIncomingHookCreate(ProjectChatSchema):
    name: str = Field(min_length=1, max_length=100)
    source_type: EventSourceType
    collection_mode: EventCollectionMode
    resource: ObservedResource
    poll_interval_seconds: int | None = Field(default=None, ge=60, le=86_400)
    credential_ref: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_poll_interval(self) -> Self:
        if self.collection_mode in {"poll", "hybrid"}:
            self.poll_interval_seconds = self.poll_interval_seconds or 300
            if not self.credential_ref:
                raise ValueError("credential_ref is required for poll or hybrid mode")
        elif self.poll_interval_seconds is not None:
            raise ValueError("poll_interval_seconds requires poll or hybrid mode")
        return self


class ProjectIncomingHookUpdate(ProjectChatSchema):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    status: IncomingHookStatus | None = None
    collection_mode: EventCollectionMode | None = None
    resource: ObservedResource | None = None
    poll_interval_seconds: int | None = Field(default=None, ge=60, le=86_400)
    credential_ref: str | None = Field(default=None, min_length=1, max_length=255)
    version: int = Field(ge=1)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class ProjectIncomingHookView(ProjectChatSchema):
    id: str
    project_id: str
    name: str
    status: IncomingHookStatus
    source_type: EventSourceType
    collection_mode: EventCollectionMode
    resource: ObservedResource
    webhook_url: str | None = None
    poll_interval_seconds: int | None = None
    credential_ref: str | None = None
    health: dict[str, Any] = Field(default_factory=dict)
    last_event_at: datetime | None = None
    next_poll_at: datetime | None = None
    version: int
    created_at: datetime
    updated_at: datetime


class ProjectIncomingReceipt(ProjectChatSchema):
    status: Literal["accepted", "duplicate"]
    provider: str
    event_id: str
    reason: str | None = None


class ProjectIncomingEventView(ProjectChatSchema):
    id: str
    subscription_id: str
    source_type: str
    collection_mode: str
    status: Literal[
        "received",
        "waiting_configuration",
        "queued",
        "clarifying",
        "dispatching",
        "routed",
        "handoff_failed",
        "processing",
        "processed",
        "unresolved",
        "ignored",
        "failed",
    ]
    normalized_events: list[dict[str, Any]] = Field(default_factory=list)
    matched_runs: list[str] = Field(default_factory=list)
    reason: str | None = None
    attempt_count: int = 0
    created_at: datetime
    updated_at: datetime


class ProjectEventSourceCatalogItem(ProjectChatSchema):
    source_type: EventSourceType
    collection_modes: list[EventCollectionMode]
    resource_types: list[str]
    event_types: list[str]
    execution_targets: list[str]
    name_key: str
    description_key: str


class ChangeRequestBindingInput(ProjectChatSchema):
    provider: Literal["github", "gitlab"]
    url: str = Field(min_length=1, max_length=2000)
    number: int = Field(ge=1)
    head_branch: str | None = Field(default=None, max_length=255)
    base_branch: str | None = Field(default=None, max_length=255)
    head_commit: str | None = Field(default=None, min_length=7, max_length=64)
    source: Literal["delivery", "runtime", "desktop", "manual", "subscription"]


class ChangeRequestBindingView(ChangeRequestBindingInput):
    instance_url: str
    repository: str
    bound_at: datetime
    last_confirmed_at: datetime
