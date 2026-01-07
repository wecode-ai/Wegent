"""
Adapters module for chat_shell.

Provides adapters for converting between different request formats.
"""

from chat_shell.adapters.wegent import (
    AttachmentInfo,
    BotConfig,
    UserInfo,
    WeGentChatRequest,
    WeGentToResponseAdapter,
)

__all__ = [
    "AttachmentInfo",
    "BotConfig",
    "UserInfo",
    "WeGentChatRequest",
    "WeGentToResponseAdapter",
]
