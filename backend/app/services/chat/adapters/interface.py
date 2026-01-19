# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell interface definitions for Backend.

This module defines the contract between Backend and Chat Shell,
matching the interface defined in chat-shell/app/interface.py.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Optional


class ChatEventType(str, Enum):
    """Types of chat events emitted during streaming."""

    START = "start"
    CHUNK = "chunk"
    THINKING = "thinking"
    TOOL_START = "tool_start"
    TOOL_RESULT = "tool_result"
    DONE = "done"
    CANCELLED = "cancelled"
    ERROR = "error"


@dataclass
class ChatRequest:
    """Chat request data structure for Chat Shell.

    Contains all information needed to process a chat message.
    """

    task_id: int
    subtask_id: int
    message: str
    user_id: int
    user_name: str
    team_id: int
    team_name: str
    request_id: str = ""
    message_id: Optional[int] = None  # Assistant's message_id for frontend ordering
    user_message_id: Optional[int] = None  # User's message_id for history exclusion
    is_group_chat: bool = False
    # User subtask ID for RAG result persistence (different from subtask_id which is AI response's subtask)
    user_subtask_id: Optional[int] = None

    # Model configuration
    model_config: dict = field(default_factory=dict)
    system_prompt: str = ""

    # Context data
    contexts: list = field(default_factory=list)
    history: list = field(default_factory=list)

    # Feature flags
    enable_tools: bool = True
    enable_web_search: bool = False
    enable_clarification: bool = False
    enable_deep_thinking: bool = True
    search_engine: Optional[str] = None

    # Bot configuration
    bot_name: str = ""
    bot_namespace: str = ""
    skills: list = field(default_factory=list)  # Skill metadata for prompt injection

    # Skill configuration for dynamic tool loading
    skill_names: list = field(default_factory=list)  # Available skill names
    skill_configs: list = field(
        default_factory=list
    )  # Skill tool configurations (with preload field)

    # Preload skills configuration (for testing)
    preload_skills: list = field(default_factory=list)  # List of skill names to preload

    # Knowledge base configuration
    knowledge_base_ids: Optional[list] = None  # Knowledge base IDs to search
    document_ids: Optional[list] = None  # Document IDs to filter retrieval
    is_user_selected_kb: bool = (
        True  # True = strict mode (user selected), False = relaxed mode (inherited)
    )

    # Table configuration
    table_contexts: list = field(
        default_factory=list
    )  # Table contexts for DataTableTool

    # Task data for MCP tools
    task_data: Optional[dict] = None

    # MCP server configuration for HTTP mode
    # Format: [{"name": "...", "url": "http://...", "type": "streamable-http", "auth": {...}}]
    mcp_servers: list = field(default_factory=list)

    # Extra tools to add
    extra_tools: list = field(default_factory=list)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "user_subtask_id": self.user_subtask_id,
            "message": self.message,
            "user_id": self.user_id,
            "user_name": self.user_name,
            "team_id": self.team_id,
            "team_name": self.team_name,
            "request_id": self.request_id,
            "message_id": self.message_id,
            "user_message_id": self.user_message_id,
            "is_group_chat": self.is_group_chat,
            "model_config": self.model_config,
            "system_prompt": self.system_prompt,
            "contexts": self.contexts,
            "history": self.history,
            "enable_tools": self.enable_tools,
            "enable_web_search": self.enable_web_search,
            "enable_clarification": self.enable_clarification,
            "enable_deep_thinking": self.enable_deep_thinking,
            "search_engine": self.search_engine,
            "bot_name": self.bot_name,
            "bot_namespace": self.bot_namespace,
            "skills": self.skills,
            "skill_names": self.skill_names,
            "skill_configs": self.skill_configs,
            "preload_skills": self.preload_skills,
            "knowledge_base_ids": self.knowledge_base_ids,
            "document_ids": self.document_ids,
            "is_user_selected_kb": self.is_user_selected_kb,
            "table_contexts": self.table_contexts,
            "task_data": self.task_data,
            "extra_tools": self.extra_tools,
            "mcp_servers": self.mcp_servers,
        }


@dataclass
class ChatEvent:
    """Chat event data structure.

    Represents a single event in the chat streaming response.
    """

    type: ChatEventType
    data: dict = field(default_factory=dict)

    @classmethod
    def from_sse_data(cls, data: dict) -> "ChatEvent":
        """Create ChatEvent from SSE data dictionary.

        Note: This method does not mutate the input dict.
        """
        # Get type without mutating input dict
        event_type_str = data.get("type", "chunk")
        try:
            event_type = ChatEventType(event_type_str)
        except ValueError:
            event_type = ChatEventType.CHUNK
        # Create a copy of data without the type field
        event_data = {k: v for k, v in data.items() if k != "type"}
        return cls(type=event_type, data=event_data)


class ChatInterface(ABC):
    """Abstract interface for Chat Shell operations.

    This interface can be implemented by:
    - PackageAdapter: Direct Python package import (in-process)
    - HTTPAdapter: HTTP/SSE remote calls (microservice)
    """

    @abstractmethod
    async def chat(self, request: ChatRequest) -> AsyncIterator[ChatEvent]:
        """Process a chat request and stream events.

        Args:
            request: Chat request data

        Yields:
            ChatEvent: Events during chat processing
        """
        pass

    @abstractmethod
    async def resume(
        self, subtask_id: int, offset: int = 0
    ) -> AsyncIterator[ChatEvent]:
        """Resume a streaming session from a given offset.

        Args:
            subtask_id: Subtask ID to resume
            offset: Character offset to resume from

        Yields:
            ChatEvent: Events from the resumed position
        """
        pass

    @abstractmethod
    async def cancel(self, subtask_id: int) -> bool:
        """Cancel an ongoing chat request.

        Args:
            subtask_id: Subtask ID to cancel

        Returns:
            bool: True if cancellation was successful
        """
        pass
