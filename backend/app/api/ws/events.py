# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Socket.IO event definitions and payload schemas.

This module defines all event names and Pydantic models for
Socket.IO message payloads.
"""

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ============================================================
# Event Names
# ============================================================

class ClientEvents:
    """Client -> Server event names."""

    # Chat events
    CHAT_SEND = "chat:send"
    CHAT_CANCEL = "chat:cancel"
    CHAT_RESUME = "chat:resume"

    # Task room events
    TASK_JOIN = "task:join"
    TASK_LEAVE = "task:leave"

    # History sync
    HISTORY_SYNC = "history:sync"


class ServerEvents:
    """Server -> Client event names."""

    # Chat streaming events (to task room)
    CHAT_START = "chat:start"
    CHAT_CHUNK = "chat:chunk"
    CHAT_DONE = "chat:done"
    CHAT_ERROR = "chat:error"
    CHAT_CANCELLED = "chat:cancelled"

    # Non-streaming messages (to task room, exclude sender)
    CHAT_MESSAGE = "chat:message"
    CHAT_BOT_COMPLETE = "chat:bot_complete"
    CHAT_SYSTEM = "chat:system"

    # Task list events (to user room)
    TASK_CREATED = "task:created"
    TASK_DELETED = "task:deleted"
    TASK_RENAMED = "task:renamed"
    TASK_STATUS = "task:status"
    TASK_SHARED = "task:shared"
    UNREAD_COUNT = "unread:count"


# ============================================================
# Client -> Server Payloads
# ============================================================

class ChatSendPayload(BaseModel):
    """Payload for chat:send event."""

    task_id: Optional[int] = Field(None, description="Task ID for multi-turn chat")
    team_id: int = Field(..., description="Team ID")
    message: str = Field(..., description="User message content")
    attachment_id: Optional[int] = Field(None, description="Optional attachment ID")
    enable_web_search: bool = Field(False, description="Enable web search")
    force_override_bot_model: Optional[str] = Field(None, description="Override model name")
    force_override_bot_model_type: Optional[str] = Field(None, description="Override model type")


class ChatCancelPayload(BaseModel):
    """Payload for chat:cancel event."""

    subtask_id: int = Field(..., description="Subtask ID to cancel")
    partial_content: Optional[str] = Field(None, description="Partial content received so far")


class ChatResumePayload(BaseModel):
    """Payload for chat:resume event."""

    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID to resume")
    offset: int = Field(0, description="Current content offset")


class TaskJoinPayload(BaseModel):
    """Payload for task:join event."""

    task_id: int = Field(..., description="Task ID to join")


class TaskLeavePayload(BaseModel):
    """Payload for task:leave event."""

    task_id: int = Field(..., description="Task ID to leave")


class HistorySyncPayload(BaseModel):
    """Payload for history:sync event."""

    task_id: int = Field(..., description="Task ID")
    after_message_id: int = Field(..., description="Get messages after this ID")


# ============================================================
# Server -> Client Payloads
# ============================================================

class ChatStartPayload(BaseModel):
    """Payload for chat:start event."""

    task_id: int
    subtask_id: int
    bot_name: Optional[str] = None


class ChatChunkPayload(BaseModel):
    """Payload for chat:chunk event."""

    subtask_id: int
    content: str
    offset: int


class ChatDonePayload(BaseModel):
    """Payload for chat:done event."""

    subtask_id: int
    offset: int
    result: Dict[str, Any] = Field(default_factory=dict)


class ChatErrorPayload(BaseModel):
    """Payload for chat:error event."""

    subtask_id: int
    error: str
    type: Optional[str] = None


class ChatCancelledPayload(BaseModel):
    """Payload for chat:cancelled event."""

    subtask_id: int


class ChatMessagePayload(BaseModel):
    """Payload for chat:message event (non-streaming message)."""

    subtask_id: int
    task_id: int
    role: str
    content: str
    sender: Dict[str, Any] = Field(default_factory=dict)
    created_at: str


class ChatBotCompletePayload(BaseModel):
    """Payload for chat:bot_complete event."""

    subtask_id: int
    task_id: int
    content: str
    result: Dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[str] = None


class ChatSystemPayload(BaseModel):
    """Payload for chat:system event."""

    task_id: int
    type: str
    content: str
    data: Optional[Dict[str, Any]] = None


class TaskCreatedPayload(BaseModel):
    """Payload for task:created event."""

    task_id: int
    title: str
    team_id: int
    team_name: str
    created_at: str


class TaskDeletedPayload(BaseModel):
    """Payload for task:deleted event."""

    task_id: int


class TaskRenamedPayload(BaseModel):
    """Payload for task:renamed event."""

    task_id: int
    title: str


class TaskStatusPayload(BaseModel):
    """Payload for task:status event."""

    task_id: int
    status: str
    progress: Optional[int] = None


class TaskSharedPayload(BaseModel):
    """Payload for task:shared event."""

    task_id: int
    title: str
    shared_by: Dict[str, Any]


class UnreadCountPayload(BaseModel):
    """Payload for unread:count event."""

    count: int


# ============================================================
# ACK Responses
# ============================================================

class ChatSendAck(BaseModel):
    """ACK response for chat:send event."""

    task_id: Optional[int] = None
    subtask_id: Optional[int] = None
    error: Optional[str] = None


class TaskJoinAck(BaseModel):
    """ACK response for task:join event."""

    streaming: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class HistorySyncAck(BaseModel):
    """ACK response for history:sync event."""

    messages: List[Dict[str, Any]] = Field(default_factory=list)
    error: Optional[str] = None


class GenericAck(BaseModel):
    """Generic ACK response."""

    success: bool = True
    error: Optional[str] = None
