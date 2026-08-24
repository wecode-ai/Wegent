# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for deterministic project incoming hooks."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

IncomingHookStatus = Literal["active", "disabled"]


class ProjectIncomingHookCreate(BaseModel):
    name: str = Field(default="外部系统", min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return value.strip()


class ProjectIncomingHookUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    status: IncomingHookStatus | None = None
    version: int = Field(ge=1)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class ProjectIncomingHookView(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    name: str
    status: IncomingHookStatus
    webhook_url: str
    version: int
    created_at: datetime
    updated_at: datetime


class ProjectIncomingReceipt(BaseModel):
    status: Literal["created", "duplicate", "ignored", "failed"]
    provider: str
    event_id: str
    loop_item_id: str | None = None
    reason: str | None = None
