# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Simple Chat Service - Lightweight LLM chat for wizard and simple scenarios.

This module provides a minimal chat service without complex features like:
- Database operations
- Session management
- MCP tools
- Skills
- Web search

It's designed for simple use cases like:
- Wizard prompt testing
- One-off LLM calls
- Simple streaming responses

Usage:
    from app.services.simple_chat import simple_chat_service

    # Non-streaming
    response = await simple_chat_service.chat_completion(
        message="Hello",
        model_config=model_config,
        system_prompt="You are a helpful assistant",
    )

    # Streaming
    stream_response = await simple_chat_service.chat_stream(
        message="Hello",
        model_config=model_config,
        system_prompt="You are a helpful assistant",
    )
"""

from app.services.simple_chat.service import SimpleChatService, simple_chat_service

__all__ = [
    "SimpleChatService",
    "simple_chat_service",
]
