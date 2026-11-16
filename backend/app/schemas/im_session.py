# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for private IM addresses and routing modes."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class IMPrivateSessionOut(BaseModel):
    session_key: str
    channel_type: str
    channel_label: str
    channel_id: int
    conversation_id: str
    sender_id: str
    display_name: str
    mode: Literal["chat", "stand_in"]
    last_seen_at: datetime
    stand_in: dict[str, str | None] | None = None


class IMPrivateSessionListResponse(BaseModel):
    total: int
    items: list[IMPrivateSessionOut]
