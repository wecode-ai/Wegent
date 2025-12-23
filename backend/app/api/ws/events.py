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
    CHAT_COMPARE_SEND = "chat:compare_send"  # Multi-model comparison request
    CHAT_COMPARE_SELECT = "chat:compare_select"  # Select best response

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

    # Multi-model comparison events
    CHAT_COMPARE_START = "chat:compare_start"  # Comparison streaming started
    CHAT_COMPARE_CHUNK = "chat:compare_chunk"  # Chunk with model_id
    CHAT_COMPARE_DONE = "chat:compare_done"  # Single model response completed
    CHAT_COMPARE_ALL_DONE = "chat:compare_all_done"  # All models completed
    CHAT_COMPARE_ERROR = "chat:compare_error"  # Error for specific model
    CHAT_COMPARE_SELECTED = "chat:compare_selected"  # Response selected notification

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
    TASK_INVITED = "task:invited"  # User invited to group chat
    UNREAD_COUNT = "unread:count"


# ============================================================
# Client -> Server Payloads
# ============================================================


class ChatSendPayload(BaseModel):
    """Payload for chat:send event."""

    task_id: Optional[int] = Field(None, description="Task ID for multi-turn chat")
    team_id: int = Field(..., description="Team ID")
    message: str = Field(..., description="User message content")
    title: Optional[str] = Field(None, description="Custom title for new tasks")
    attachment_id: Optional[int] = Field(None, description="Optional attachment ID")
    enable_web_search: bool = Field(False, description="Enable web search")
    search_engine: Optional[str] = Field(None, description="Search engine to use")
    enable_clarification: bool = Field(
        False, description="Enable clarification mode for smart follow-up questions"
    )
    force_override_bot_model: Optional[str] = Field(
        None, description="Override model name"
    )
    force_override_bot_model_type: Optional[str] = Field(
        None, description="Override model type"
    )
    is_group_chat: bool = Field(
        False, description="Whether this is a group chat (for new tasks)"
    )
    # Repository info for code tasks
    git_url: Optional[str] = Field(None, description="Git repository URL")
    git_repo: Optional[str] = Field(None, description="Git repository name")
    git_repo_id: Optional[int] = Field(None, description="Git repository ID")
    git_domain: Optional[str] = Field(None, description="Git domain")
    branch_name: Optional[str] = Field(None, description="Git branch name")
    task_type: Optional[Literal["chat", "code"]] = Field(
        None, description="Task type: chat or code"
    )


class ChatCancelPayload(BaseModel):
    """Payload for chat:cancel event."""

    subtask_id: int = Field(..., description="Subtask ID to cancel")
    partial_content: Optional[str] = Field(
        None, description="Partial content received so far"
    )
    shell_type: Optional[str] = Field(
        None, description="Shell type of the bot (e.g., 'Chat', 'ClaudeCode', 'Agno')"
    )


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


class ModelConfig(BaseModel):
    """Model configuration for multi-model comparison."""

    name: str = Field(..., description="Model name/identifier")
    display_name: Optional[str] = Field(None, description="Display name for UI")
    type: Optional[str] = Field(None, description="Model type: 'public' or 'user'")


class ChatCompareSendPayload(BaseModel):
    """Payload for chat:compare_send event (multi-model comparison)."""

    task_id: Optional[int] = Field(None, description="Task ID for multi-turn chat")
    team_id: int = Field(..., description="Team ID")
    message: str = Field(..., description="User message content")
    title: Optional[str] = Field(None, description="Custom title for new tasks")
    models: List[ModelConfig] = Field(
        ...,
        description="List of models to compare (2-4 models)",
        min_length=2,
        max_length=4,
    )
    attachment_id: Optional[int] = Field(None, description="Optional attachment ID")
    enable_web_search: bool = Field(False, description="Enable web search")
    search_engine: Optional[str] = Field(None, description="Search engine to use")
    # Repository info for code tasks
    git_url: Optional[str] = Field(None, description="Git repository URL")
    git_repo: Optional[str] = Field(None, description="Git repository name")
    git_repo_id: Optional[int] = Field(None, description="Git repository ID")
    git_domain: Optional[str] = Field(None, description="Git domain")
    branch_name: Optional[str] = Field(None, description="Git branch name")
    task_type: Optional[Literal["chat", "code"]] = Field(
        None, description="Task type: chat or code"
    )


class ChatCompareSelectPayload(BaseModel):
    """Payload for chat:compare_select event (select best response)."""

    task_id: int = Field(..., description="Task ID")
    compare_group_id: str = Field(..., description="Comparison group ID")
    selected_subtask_id: int = Field(..., description="Selected subtask ID")


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
    message_id: Optional[int] = None  # Add message_id for message ordering
    task_id: Optional[int] = None  # Add task_id for group chat members


class ChatErrorPayload(BaseModel):
    """Payload for chat:error event."""

    subtask_id: int
    error: str
    type: Optional[str] = None


class ChatCancelledPayload(BaseModel):
    """Payload for chat:cancelled event."""

    subtask_id: int


# Multi-model comparison server payloads
class ChatCompareStartPayload(BaseModel):
    """Payload for chat:compare_start event."""

    task_id: int
    compare_group_id: str = Field(
        ..., description="Unique ID for this comparison group"
    )
    models: List[Dict[str, Any]] = Field(
        ..., description="List of models with their subtask_ids"
    )
    # Format: [{"model_name": str, "model_display_name": str, "subtask_id": int}, ...]


class ChatCompareChunkPayload(BaseModel):
    """Payload for chat:compare_chunk event."""

    subtask_id: int
    compare_group_id: str
    model_name: str
    content: str
    offset: int


class ChatCompareDonePayload(BaseModel):
    """Payload for chat:compare_done event (single model completed)."""

    subtask_id: int
    compare_group_id: str
    model_name: str
    offset: int
    result: Dict[str, Any] = Field(default_factory=dict)


class ChatCompareAllDonePayload(BaseModel):
    """Payload for chat:compare_all_done event (all models completed)."""

    task_id: int
    compare_group_id: str
    message_id: Optional[int] = None


class ChatCompareErrorPayload(BaseModel):
    """Payload for chat:compare_error event (error for specific model)."""

    subtask_id: int
    compare_group_id: str
    model_name: str
    error: str
    type: Optional[str] = None


class ChatCompareSelectedPayload(BaseModel):
    """Payload for chat:compare_selected event."""

    task_id: int
    compare_group_id: str
    selected_subtask_id: int
    model_name: str


class ChatMessagePayload(BaseModel):
    """Payload for chat:message event (non-streaming message)."""

    subtask_id: int
    task_id: int
    message_id: int = Field(
        ..., description="Message ID for ordering (primary sort key)"
    )
    role: str
    content: str
    sender: Dict[str, Any] = Field(default_factory=dict)
    created_at: str
    attachment: Optional[Dict[str, Any]] = Field(
        None, description="Single attachment info (for backward compatibility)"
    )
    attachments: Optional[List[Dict[str, Any]]] = Field(
        None, description="Multiple attachments info"
    )


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
    completed_at: Optional[str] = None


class TaskSharedPayload(BaseModel):
    """Payload for task:shared event."""

    task_id: int
    title: str
    shared_by: Dict[str, Any]


class TaskInvitedPayload(BaseModel):
    """Payload for task:invited event (user invited to group chat)."""

    task_id: int
    title: str
    team_id: int
    team_name: str
    invited_by: Dict[str, Any]
    is_group_chat: bool = True
    created_at: str


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
    message_id: Optional[int] = None  # Message ID for the user's subtask
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


class ChatCompareSendAck(BaseModel):
    """ACK response for chat:compare_send event."""

    task_id: Optional[int] = None
    compare_group_id: Optional[str] = None
    user_subtask_id: Optional[int] = None
    message_id: Optional[int] = None
    models: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="List of models with subtask_ids: [{model_name, subtask_id}]",
    )
    error: Optional[str] = None


class ChatCompareSelectAck(BaseModel):
    """ACK response for chat:compare_select event."""

    success: bool = True
    error: Optional[str] = None
