# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for private IM task continuation sessions."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

IMSessionModeValue = Literal["chat", "task"]
IMBotPurposeValue = Literal["wegent_chat", "wework_local"]
IMSessionStateValue = Literal[
    "idle",
    "pending_new_flow",
    "pending_task_switch",
    "pending_task_creation",
]


class IMPrivateSessionOut(BaseModel):
    session_key: str
    channel_type: str
    channel_label: str
    channel_id: int
    bot_purpose: IMBotPurposeValue = "wegent_chat"
    conversation_id: str
    sender_id: str
    display_name: str
    mode: IMSessionModeValue
    state: IMSessionStateValue
    active_task_id: int | None = None
    current_target_type: str | None = None
    current_target_label: str | None = None
    last_seen_at: datetime


class IMPrivateSessionListResponse(BaseModel):
    total: int
    items: list[IMPrivateSessionOut]


class BindTaskIMSessionsRequest(BaseModel):
    session_keys: list[str] = Field(min_length=1)


class BindTaskIMSessionsResponse(BaseModel):
    task_id: int
    bound_session_keys: list[str]
    notified_count: int
