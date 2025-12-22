# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph-based Chat Service module.

This module provides a LangGraph-based Chat Service implementation using
LangChain/LangGraph framework with support for:
- Database-based model resolution
- Tool calling and multi-step reasoning
- MCP integration
- Redis session management
- WebSocket event emission
- SSE streaming responses

Architecture:
- models/: Model resolution and LangChain model factory
- messages/: Message format conversion
- storage/: Redis/Database storage operations
- events/: WebSocket event emission
- agents/: LangGraph agent workflow
- tools/: Tool registry and built-in tools
"""

from .service import (
    CompletionResponse,
    LangGraphChatService,
    StreamChunk,
    extract_usage_from_response,
    langgraph_chat_service,
)

__all__ = [
    "LangGraphChatService",
    "langgraph_chat_service",
    "CompletionResponse",
    "StreamChunk",
    "extract_usage_from_response",
]
