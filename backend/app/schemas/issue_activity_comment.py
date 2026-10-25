# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Comment views with the activity cursor used by Issue subscriptions."""

from pydantic import Field

from app.schemas.delivery import LoopItemCommentCreate, LoopItemCommentResponse
from app.schemas.project_chat import ProjectChatMention


class IssueActivityCommentCreate(LoopItemCommentCreate):
    mentions: list[ProjectChatMention] = Field(default_factory=list, max_length=64)


class IssueActivityCommentResponse(LoopItemCommentResponse):
    sequence_number: int
    mentions: list[ProjectChatMention] = Field(default_factory=list)
