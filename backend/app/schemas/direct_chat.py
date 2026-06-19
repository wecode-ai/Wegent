# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for Wework-to-executor direct chat control plane."""

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field

from app.api.ws.events import ChatSendPayload
from app.schemas.device import DirectChatCapability


class DirectChatConnectionResponse(BaseModel):
    """Signed connection information returned to Wework."""

    connection_id: str
    token: str
    device_id: str
    expires_at: datetime
    endpoint: DirectChatCapability


class DirectChatAuthorizeConnectionPayload(BaseModel):
    """Backend-to-executor authorization payload."""

    connection_id: str
    token: str
    user_id: int
    user_name: str
    device_id: str
    expires_at: datetime


class DirectChatTurnPrepareRequest(BaseModel):
    """Executor request to persist one user turn and build execution context."""

    connection_id: Optional[str] = Field(
        None, description="Direct chat connection ID used by Wework"
    )
    payload: ChatSendPayload


class DirectChatTurnPrepareResponse(BaseModel):
    """Prepared task/subtask identifiers and executor request for one turn."""

    success: bool = True
    task_id: int
    user_subtask_id: Optional[int] = None
    user_message_id: Optional[int] = None
    assistant_subtask_id: Optional[int] = None
    assistant_message_id: Optional[int] = None
    assistant_started_at: Optional[datetime] = None
    ai_triggered: bool = True
    execution_request: Optional[dict[str, Any]] = None


class DirectChatErrorResponse(BaseModel):
    """Simple direct chat error response."""

    success: bool = False
    error: str
