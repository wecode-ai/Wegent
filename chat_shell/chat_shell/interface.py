# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell unified interface definitions.

This module defines the contract between Backend and Chat Shell,
supporting both package import and HTTP/SSE communication modes.
"""

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Optional


class ChatEventType(str, Enum):
    """Types of chat events emitted during streaming."""

    START = "start"
    CHUNK = "chunk"
    THINKING = "thinking"
    TOOL = "tool"  # Generic tool event (for tool callbacks)
    TOOL_START = "tool_start"
    TOOL_RESULT = "tool_result"
    DONE = "done"
    CANCELLED = "cancelled"
    ERROR = "error"


@dataclass
class ChatRequest:
    """Chat request data structure.

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
    mcp_servers: list = field(default_factory=list)

    # Extra tools to add
    extra_tools: list = field(default_factory=list)


@dataclass
class ChatEvent:
    """Chat event data structure.

    Represents a single event in the chat streaming response.
    """

    type: ChatEventType
    data: dict = field(default_factory=dict)

    def to_sse(self) -> str:
        """Format as SSE data line."""
        event_data = {"type": self.type.value, **self.data}
        return f"data: {json.dumps(event_data)}\n\n"


class ChatInterface(ABC):
    """Abstract interface for Chat Shell operations.

    This interface can be implemented by:
    - PackageAdapter: Direct Python package import
    - HTTPAdapter: HTTP/SSE remote calls
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

        Used for reconnection after network interruption.

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
