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
- agent.py: ChatAgent for agent creation and execution (agent-only logic)
- streaming_handler.py: ChatStreamingHandler for WebSocket/SSE streaming
- service.py: ChatService facade that combines agent and streaming
- streaming/: Streaming infrastructure (re-exports from app.services.streaming)
- config/: Chat configuration builders
- agents/: LangGraph agent builders
- messages/: Message conversion utilities
- models/: LangChain model factory
- storage/: Unified storage handler
- tools/: Tool registry and implementations
"""

from .ai_trigger import trigger_ai_response
from .agent import AgentConfig, ChatAgent, chat_agent
from .service import ChatService, WebSocketStreamConfig, chat_service
from .streaming_handler import ChatStreamingHandler

__all__ = [
    # Main service (facade)
    "ChatService",
    "chat_service",
    # Agent (pure agent logic)
    "ChatAgent",
    "chat_agent",
    "AgentConfig",
    # Streaming handler (WebSocket/SSE logic)
    "ChatStreamingHandler",
    "WebSocketStreamConfig",
    # AI trigger
    "trigger_ai_response",
]
