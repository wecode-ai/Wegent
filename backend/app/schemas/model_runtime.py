# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for stateless model runtime API."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class StatelessRuntimeMessage(BaseModel):
    role: str
    content: str


class StatelessModelReference(BaseModel):
    name: str
    type: Literal["public", "user", "group"]
    namespace: str
    resource_user_id: int


class StatelessResponseCreateRequest(BaseModel):
    model: str
    input: list[StatelessRuntimeMessage] | str
    instructions: str | None = None
    stream: bool = False
    metadata: dict[str, Any] | None = None
    runtime_model_config: dict[str, Any] | None = Field(
        default=None, alias="model_config"
    )
    model_ref: StatelessModelReference | None = None
    tools: list[dict[str, Any]] | None = None


class StatelessResponseCreateResult(BaseModel):
    output_text: str
    model: str
    created_at: datetime
