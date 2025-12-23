# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
LLM Provider abstraction layer.

This module provides a unified interface for different LLM providers
(OpenAI, Claude, Gemini) with streaming support and tool calling.
"""

from app.services.chat.providers.base import (
    ChunkType,
    LLMProvider,
    StreamChunk,
    extract_image_url,
    parse_base64_image,
)
from app.services.chat.providers.claude import ClaudeProvider
from app.services.chat.providers.factory import get_provider
from app.services.chat.providers.gemini import GeminiProvider
from app.services.chat.providers.openai import OpenAIProvider

__all__ = [
    "ChunkType",
    "ClaudeProvider",
    "GeminiProvider",
    "LLMProvider",
    "OpenAIProvider",
    "StreamChunk",
    "extract_image_url",
    "get_provider",
    "parse_base64_image",
]
