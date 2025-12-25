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
    CHAT_RETRY = "chat:retry"

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
    TASK_INVITED = "task:invited"  # User invited to group chat
    UNREAD_COUNT = "unread:count"


# ============================================================
# Client -> Server Payloads
# ============================================================


class ContextItem(BaseModel):
    """Generic context item that can be of different types."""

    type: str = Field(..., description="Context type (e.g., 'knowledge_base')")
    data: Dict[str, Any] = Field(..., description="Context-specific data")


class ChatSendPayload(BaseModel):
    """Payload for chat:send event."""

    task_id: Optional[int] = Field(None, description="Task ID for multi-turn chat")
    team_id: int = Field(..., description="Team ID")
    message: str = Field(..., description="User message content")
    title: Optional[str] = Field(None, description="Custom title for new tasks")
    attachment_id: Optional[int] = Field(
        None, description="Optional attachment ID (deprecated, use attachment_ids)"
    )
    attachment_ids: Optional[List[int]] = Field(
        None, description="Optional list of attachment IDs"
    )
    enable_deep_thinking: bool = Field(
        False, description="Enable deep thinking mode (uses chat_v2)"
    )
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
    contexts: Optional[List[ContextItem]] = Field(
        None, description="Context items (knowledge bases, etc.)"
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


class ChatRetryPayload(BaseModel):
    """Payload for chat:retry event."""

    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Failed AI subtask ID to retry")
    # Optional: Model to use for retry (overrides task metadata model if provided)
    force_override_bot_model: Optional[str] = Field(
        None, description="Model ID to override bot model for this retry"
    )
    force_override_bot_model_type: Optional[str] = Field(
        None, description="Model type (public/user) for the override model"
    )
    # Flag indicating whether to use model override
    # When false and force_override_bot_model is None, use bot's default model
    use_model_override: bool = Field(
        False,
        description="If true, use force_override_bot_model; if false, use bot's default model",
    )


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


class SourceReference(BaseModel):
    """Reference to a knowledge base source document."""

    index: int = Field(..., description="Source index number (e.g., 1, 2, 3)")
    title: str = Field(..., description="Document title/filename")
    kb_id: int = Field(..., description="Knowledge base ID")


class ChatChunkPayload(BaseModel):
    """Payload for chat:chunk event."""

    subtask_id: int
    content: str
    offset: int
    sources: Optional[List[SourceReference]] = Field(
        None, description="Knowledge base source references (for RAG citations)"
    )


class ChatDonePayload(BaseModel):
    """Payload for chat:done event."""

    subtask_id: int
    offset: int
    result: Dict[str, Any] = Field(default_factory=dict)
    message_id: Optional[int] = None  # Add message_id for message ordering
    task_id: Optional[int] = None  # Add task_id for group chat members
    sources: Optional[List[SourceReference]] = Field(
        None, description="Knowledge base source references (for RAG citations)"
    )


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
