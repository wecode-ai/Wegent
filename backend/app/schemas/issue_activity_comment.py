# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Comment views with the activity cursor used by Issue subscriptions."""

from typing import Literal

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
    status: str = Field(default="completed", max_length=32)
    evidence_refs: list[str] = Field(default_factory=list, max_length=64)
    publish_policy: str = Field(default="summary_only", max_length=32)
    next_action: str | None = Field(default=None, max_length=500)


class AssistantPublicationSource(BaseModel):
    device_id: str = Field(min_length=1, max_length=255)
    task_id: str = Field(min_length=1, max_length=255)
    requires_confirmation: bool = False


class CollaborationPublicReply(BaseModel):
    device_id: str = Field(min_length=1, max_length=255)
    task_id: str = Field(min_length=1, max_length=255)
    dispatch_id: str = Field(min_length=1, max_length=255)
    message_id: str = Field(min_length=1, max_length=64)
    trigger_comment_id: str | None = Field(default=None, min_length=1, max_length=64)
    turn_id: str | None = Field(default=None, min_length=1, max_length=64)
    phase: Literal["start", "output"] | None = None
    execution_trigger_comment_id: str | None = Field(
        default=None, min_length=1, max_length=64
    )


class IssueActivityCommentCreate(LoopItemCommentCreate):
    client_message_id: str | None = Field(default=None, min_length=1, max_length=64)
    mentions: list[ProjectChatMention] = Field(default_factory=list, max_length=64)
    stand_in: StandInPublicReply | None = None
    collaboration: CollaborationPublicReply | None = None
    reply_to_comment_id: str | None = Field(default=None, min_length=1, max_length=64)
    assistant_source: AssistantPublicationSource | None = None


class IssueActivityCommentResponse(LoopItemCommentResponse):
    sequence_number: int
    reply_to_comment_id: str | None = None
    root_comment_id: str | None = None
    mentions: list[ProjectChatMention] = Field(default_factory=list)
    stand_in_reply_to: dict | None = None
    actor_user_id: str | None = None
    actor_display_name: str | None = None
    generation_source: str = "human"
    publication_source: str = "human"
    confirmation_state: str = "unknown"
    trace_ref: str | None = None
    trace_state: str = "history-unavailable"
