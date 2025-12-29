# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
LLM Provider abstraction layer for Simple Chat.

This module provides a unified interface for different LLM providers
(OpenAI, Claude, Gemini) with streaming support.
"""

from app.services.simple_chat.providers.base import (
    ChunkType,
    LLMProvider,
    ProviderConfig,
    StreamChunk,
)
from app.services.simple_chat.providers.claude import ClaudeProvider
from app.services.simple_chat.providers.factory import get_provider
from app.services.simple_chat.providers.gemini import GeminiProvider
from app.services.simple_chat.providers.openai import OpenAIProvider

__all__ = [
    "ChunkType",
    "ClaudeProvider",
    "GeminiProvider",
    "LLMProvider",
    "OpenAIProvider",
    "ProviderConfig",
    "StreamChunk",
    "get_provider",
]
