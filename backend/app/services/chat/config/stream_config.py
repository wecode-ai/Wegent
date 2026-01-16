# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""WebSocket streaming configuration for Chat Service.

This module provides configuration dataclass for WebSocket streaming sessions.
"""

from dataclasses import dataclass, field

from langchain_core.tools.base import BaseTool

from .features import Features


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

        features: Unified feature flags (enable_tools, enable_canvas, etc.)

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

    # Feature flags - unified in Features object
    features: Features = field(default_factory=Features)

    # Bot configuration
    bot_name: str = ""
    bot_namespace: str = "default"
    shell_type: str = "Chat"  # Shell type for frontend display
    extra_tools: list[BaseTool] = field(default_factory=list)

    # Legacy skill metadata for prompt injection (TODO: move to Features?)
    skills: list[dict] = field(
        default_factory=list
    )  # Skill metadata for prompt injection

    # Context flags
    has_table_context: bool = False  # Whether user selected table context

    def get_username_for_message(self) -> str | None:
        """Get username for message prefix in group chat mode."""
        return self.user_name if self.is_group_chat else None

    # Backward compatibility properties
    @property
    def enable_tools(self) -> bool:
        """Backward compatibility: access features.enable_tools."""
        return self.features.enable_tools

    @property
    def enable_web_search(self) -> bool:
        """Backward compatibility: access features.enable_web_search."""
        return self.features.enable_web_search

    @property
    def enable_clarification(self) -> bool:
        """Backward compatibility: access features.enable_clarification."""
        return self.features.enable_clarification

    @property
    def enable_deep_thinking(self) -> bool:
        """Backward compatibility: access features.enable_deep_thinking."""
        return self.features.enable_deep_thinking

    @property
    def enable_canvas(self) -> bool:
        """Backward compatibility: access features.enable_canvas."""
        return self.features.enable_canvas

    @property
    def search_engine(self) -> str | None:
        """Backward compatibility: access features.search_engine."""
        return self.features.search_engine
