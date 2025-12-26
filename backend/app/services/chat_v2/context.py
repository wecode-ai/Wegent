# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat context dataclasses for better separation of concerns.

This module provides typed context objects that group related parameters:
- ChatUserContext: User identity and session information
- ChatMessageContext: Message ordering and history control
- ChatFeatureFlags: Feature toggles (web search, deep thinking, etc.)
- ChatBotContext: Bot/Team/Ghost configuration

These contexts are composed into WebSocketStreamConfig for streaming.
"""

from dataclasses import dataclass, field
from typing import Any

from langchain_core.tools.base import BaseTool


@dataclass(frozen=True)
class ChatUserContext:
    """User identity and session context.

    Immutable context containing user identification for the chat session.
    Used for history retrieval, permission checks, and group chat prefixes.
    """

    user_id: int
    user_name: str
    is_group_chat: bool = False

    def get_message_prefix(self) -> str | None:
        """Get username prefix for messages in group chat mode.

        Returns:
            Prefix string like 'User[username]: ' for group chat, None for single chat
        """
        if self.is_group_chat and self.user_name:
            return f"User[{self.user_name}]: "
        return None


@dataclass(frozen=True)
class ChatMessageContext:
    """Message ordering and history context.

    Contains message IDs for proper ordering in frontend and
    history exclusion to prevent duplicate messages.
    """

    # Assistant's message_id for frontend ordering (displayed in chat list)
    assistant_message_id: int | None = None

    # User's message_id for history exclusion
    # When loading history, exclude messages with message_id >= this value
    # This prevents the current user message from appearing twice
    # (once from DB history, once from build_messages())
    user_message_id: int | None = None

    def get_history_cutoff_id(self) -> int | None:
        """Get the message_id cutoff for history loading.

        Messages with message_id >= this value will be excluded from history.
        This is the user_message_id since we want to exclude the current
        user message (it will be added separately by build_messages()).

        Returns:
            The user_message_id to use as cutoff, or None if not set
        """
        return self.user_message_id


@dataclass
class ChatFeatureFlags:
    """Feature toggles for chat session.

    Configurable features that can be enabled/disabled per chat.
    """

    enable_web_search: bool = False
    search_engine: str | None = None


@dataclass
class ChatBotContext:
    """Bot configuration context.

    Contains resolved bot, ghost, and shell information.
    """

    bot_name: str = ""
    bot_namespace: str = "default"
    shell_type: str = "Chat"  # Chat, ClaudeCode, Agno, etc.
    extra_tools: list[BaseTool] = field(default_factory=list)


@dataclass
class ChatStreamContext:
    """Complete context for a chat streaming session.

    Composes all context objects needed for WebSocket streaming.
    This is the main interface between ai_trigger and ChatService.
    """

    # Task identification
    task_id: int
    subtask_id: int
    task_room: str

    # Composed contexts
    user: ChatUserContext
    message: ChatMessageContext
    features: ChatFeatureFlags
    bot: ChatBotContext

    @classmethod
    def create(
        cls,
        task_id: int,
        subtask_id: int,
        task_room: str,
        user_id: int,
        user_name: str,
        is_group_chat: bool = False,
        assistant_message_id: int | None = None,
        user_message_id: int | None = None,
        enable_web_search: bool = False,
        search_engine: str | None = None,
        bot_name: str = "",
        bot_namespace: str = "default",
        shell_type: str = "Chat",
        extra_tools: list[BaseTool] | None = None,
    ) -> "ChatStreamContext":
        """Factory method for convenient construction.

        Args:
            task_id: Task ID
            subtask_id: Assistant subtask ID
            task_room: WebSocket room name
            user_id: User ID
            user_name: User name for group chat prefix
            is_group_chat: Whether this is a group chat
            assistant_message_id: Assistant's message_id for frontend ordering
            user_message_id: User's message_id for history exclusion
            enable_web_search: Enable web search tool
            search_engine: Specific search engine to use
            bot_name: Bot name for MCP loading
            bot_namespace: Bot namespace
            shell_type: Shell type (Chat, ClaudeCode, etc.)
            extra_tools: Additional tools (e.g., KnowledgeBaseTool)

        Returns:
            ChatStreamContext instance
        """
        return cls(
            task_id=task_id,
            subtask_id=subtask_id,
            task_room=task_room,
            user=ChatUserContext(
                user_id=user_id,
                user_name=user_name,
                is_group_chat=is_group_chat,
            ),
            message=ChatMessageContext(
                assistant_message_id=assistant_message_id,
                user_message_id=user_message_id,
            ),
            features=ChatFeatureFlags(
                enable_web_search=enable_web_search,
                search_engine=search_engine,
            ),
            bot=ChatBotContext(
                bot_name=bot_name,
                bot_namespace=bot_namespace,
                shell_type=shell_type,
                extra_tools=extra_tools or [],
            ),
        )

    def get_username_for_message(self) -> str | None:
        """Get username for message prefix in group chat mode.

        Returns:
            Username string for group chat, None for single chat
        """
        if self.user.is_group_chat:
            return self.user.user_name
        return None
