# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schemas for authenticated Wework feedback submissions."""

from typing import Any

from pydantic import BaseModel, Field


class FeedbackCreate(BaseModel):
    report_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=20_000)
    context: dict[str, Any] = Field(default_factory=dict)


class FeedbackResponse(BaseModel):
    report_id: str
    project_id: str
    item_id: str
    created_by_user_id: int
    duplicate: bool
