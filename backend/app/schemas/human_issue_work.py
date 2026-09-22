# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Versioned actions for a human assigned to a native cloud Issue."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.delivery import LoopItemResponse
from app.schemas.project_chat import ProjectChatMessageView


class HumanWorkStart(BaseModel):
    version: int = Field(ge=1)


class HumanWorkSubmit(HumanWorkStart):
    request_id: str = Field(min_length=1, max_length=64)
    summary: str = Field(min_length=1, max_length=100_000)


class HumanWorkReview(HumanWorkStart):
    request_id: str = Field(min_length=1, max_length=64)
    decision: Literal["accept", "request_changes"]
    reason: str | None = Field(default=None, max_length=10_000)

    @model_validator(mode="after")
    def require_rejection_reason(self) -> "HumanWorkReview":
        if self.decision == "request_changes" and not (self.reason or "").strip():
            raise ValueError("A reason is required when requesting changes")
        return self


class HumanWorkActionResponse(BaseModel):
    issue: LoopItemResponse
    message: ProjectChatMessageView | None = None
