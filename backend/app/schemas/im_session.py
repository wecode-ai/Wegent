# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for private IM task continuation sessions."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

IMSessionModeValue = Literal["chat", "task"]
IMSessionStateValue = Literal["idle", "pending_task_switch", "pending_task_creation"]


class IMPrivateSessionOut(BaseModel):
    id: int
    channel_type: str
    channel_label: str
    channel_id: int
    conversation_id: str
    sender_id: str
    display_name: str
    mode: IMSessionModeValue
    state: IMSessionStateValue
    active_task_id: int | None = None
    last_seen_at: datetime


class IMPrivateSessionListResponse(BaseModel):
    total: int
    items: list[IMPrivateSessionOut]


class BindTaskIMSessionsRequest(BaseModel):
    session_ids: list[int] = Field(min_length=1)


class BindTaskIMSessionsResponse(BaseModel):
    task_id: int
    bound_session_ids: list[int]
    notified_count: int
