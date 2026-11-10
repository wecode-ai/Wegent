# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Comment views with the activity cursor used by Issue subscriptions."""

from pydantic import BaseModel, Field

from app.schemas.delivery import LoopItemCommentCreate, LoopItemCommentResponse
from app.schemas.project_chat import ProjectChatMention


class StandInPublicReply(BaseModel):
    """Identity of one public message, never an execution authorization."""

    device_id: str = Field(min_length=1, max_length=255)
    task_id: str = Field(min_length=1, max_length=255)
    role_id: str = Field(min_length=1, max_length=128)
    role_name: str = Field(min_length=1, max_length=100)
    message_id: str = Field(min_length=1, max_length=64)
    human_assignment_id: str | None = Field(default=None, max_length=255)
    trigger_comment_id: str | None = Field(default=None, max_length=64)


class IssueActivityCommentCreate(LoopItemCommentCreate):
    mentions: list[ProjectChatMention] = Field(default_factory=list, max_length=64)
    stand_in: StandInPublicReply | None = None


class IssueActivityCommentResponse(LoopItemCommentResponse):
    sequence_number: int
    mentions: list[ProjectChatMention] = Field(default_factory=list)
    stand_in_reply_to: dict | None = None
