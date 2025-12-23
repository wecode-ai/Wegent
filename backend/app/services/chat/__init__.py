# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Service module.

This module provides a LangGraph-based chat service that uses:
- LangGraph StateGraph for agent workflow orchestration
- LangChain for model abstraction and tool binding
- Modular streaming infrastructure (SSE and WebSocket)
- Database-based model resolution
- Redis session management

Architecture:
- streaming/: Core streaming logic and emitters
- config/: Chat configuration builders
- agents/: LangGraph agent builders
- messages/: Message conversion utilities
- models/: LangChain model factory
- storage/: Unified storage handler
- tools/: Tool registry and implementations
"""

from .ai_trigger import trigger_ai_response
from .service import ChatService, chat_service

__all__ = [
    "ChatService",
    "chat_service",
    "trigger_ai_response",
]
