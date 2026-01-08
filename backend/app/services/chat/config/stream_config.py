# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""WebSocket streaming configuration for Chat Service.

This module provides configuration dataclass for WebSocket streaming sessions.
"""

from dataclasses import dataclass, field

from langchain_core.tools.base import BaseTool


@dataclass
class WebSocketStreamConfig:
    """Configuration for WebSocket streaming.

    Attributes:
        task_id: Task ID for the chat session
        subtask_id: Assistant subtask ID
        task_room: WebSocket room name for broadcasting

        user_id: User ID for permission checks and history loading
        user_name: User name for group chat message prefix
        is_group_chat: Whether this is a group chat (affects message prefix and history truncation)

        message_id: Assistant's message_id for frontend ordering
        user_message_id: User's message_id for history exclusion (prevents duplicate messages)

        enable_web_search: Enable web search tool
        search_engine: Specific search engine to use

        bot_name: Bot name for MCP server loading
        bot_namespace: Bot namespace
        shell_type: Shell type (Chat, ClaudeCode, Agno) for frontend display
        extra_tools: Additional tools (e.g., KnowledgeBaseTool)
    """

    # Task identification
    task_id: int
    subtask_id: int
    task_room: str

    # User context
    user_id: int
    user_name: str
    is_group_chat: bool = False

    # Message ordering context
    message_id: int | None = None  # Assistant's message_id for ordering in frontend
    user_message_id: int | None = None  # User's message_id for history exclusion

    # Feature flags
    enable_tools: bool = True  # Enable tools (MCP, web search, skills, etc.)
    enable_web_search: bool = False
    search_engine: str | None = None

    # Prompt enhancement options
    enable_clarification: bool = False
    enable_deep_thinking: bool = True
    skills: list[dict] = field(
        default_factory=list
    )  # Skill metadata for prompt injection

    # Bot configuration
    bot_name: str = ""
    bot_namespace: str = "default"
    shell_type: str = "Chat"  # Shell type for frontend display
    extra_tools: list[BaseTool] = field(default_factory=list)

    # Context flags
    has_table_context: bool = False  # Whether user selected table context

    def get_username_for_message(self) -> str | None:
        """Get username for message prefix in group chat mode."""
        return self.user_name if self.is_group_chat else None
