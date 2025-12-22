# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph-based Chat Service module.

This module provides a chat service built on LangGraph's StateGraph:
- LangGraph for agent workflow orchestration (model -> tools -> model loop)
- LangChain for model abstraction and tool binding
- Database-based model resolution
- Redis session management
- SSE streaming responses

Architecture:
- agents/: LangGraph StateGraph workflow (graph_builder, state)
- models/: Model resolution and LangChain model factory
- messages/: Message format conversion
- storage/: Redis/Database storage operations
- events/: WebSocket event emission
- tools/: Tool registry and built-in tools
"""

from .service import LangGraphChatService, langgraph_chat_service

__all__ = [
    "LangGraphChatService",
    "langgraph_chat_service",
]
