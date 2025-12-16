# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell direct chat service module.

This module provides direct LLM API calling capabilities for Chat Shell type,
bypassing the Docker Executor container for lightweight chat scenarios.

Architecture (Refactored):
- providers/: LLM provider abstraction layer (OpenAI, Claude, Gemini)
- tool_handler.py: Tool calling management
- stream_manager.py: Streaming response lifecycle
- db_handler.py: Database operations
- message_builder.py: Message construction
- session_manager.py: Redis session management
- model_resolver.py: Model configuration resolution
"""

# New modular imports
from app.services.chat.chat_service import chat_service
from app.services.chat.db_handler import db_handler
from app.services.chat.message_builder import (
    build_vision_content,
    is_vision_message,
    message_builder,
    normalize_user_content,
)

# Legacy imports (for backward compatibility)
from app.services.chat.model_resolver import get_model_config_for_bot

# Provider imports
from app.services.chat.providers import (
    ChunkType,
    ClaudeProvider,
    GeminiProvider,
    LLMProvider,
    OpenAIProvider,
    StreamChunk,
    get_provider,
)
from app.services.chat.session_manager import session_manager
from app.services.chat.stream_manager import stream_manager
from app.services.chat.tool_handler import ToolCallAccumulator, ToolHandler

__all__ = [
    # Core services
    "chat_service",
    "db_handler",
    "message_builder",
    "session_manager",
    "stream_manager",
    # Tool handling
    "ToolCallAccumulator",
    "ToolHandler",
    # Message utilities
    "build_vision_content",
    "get_model_config_for_bot",
    "is_vision_message",
    "normalize_user_content",
    # Providers
    "ChunkType",
    "ClaudeProvider",
    "GeminiProvider",
    "LLMProvider",
    "OpenAIProvider",
    "StreamChunk",
    "get_provider",
]
