# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell direct chat service module.

This module provides direct LLM API calling capabilities for Chat Shell type,
bypassing the Docker Executor container for lightweight chat scenarios.

Architecture (Refactored):
- providers/: LLM provider abstraction layer (OpenAI, Claude, Gemini)
- storage/: Database and session management
- streaming/: WebSocket streaming handlers
- config/: Chat configuration
- models/: Model resolution
- prompts/: Prompt building
- tools/: Tool definitions
- trigger/: AI response triggering
- ws_emitter.py: WebSocket event emitter
"""

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

# Storage imports (from new modular structure)
from app.services.chat.storage import db_handler, session_manager, storage_handler

__all__ = [
    # Storage
    "db_handler",
    "session_manager",
    "storage_handler",
    # Providers
    "ChunkType",
    "ClaudeProvider",
    "GeminiProvider",
    "LLMProvider",
    "OpenAIProvider",
    "StreamChunk",
    "get_provider",
]
