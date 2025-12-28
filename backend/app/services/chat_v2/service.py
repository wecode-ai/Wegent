# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Service - main service entry point.

This module provides a LangGraph-based chat service that uses:
- LangGraph StateGraph for agent workflow orchestration
- LangChain for model abstraction and tool binding
- Modular streaming infrastructure (SSE and WebSocket)
- Database-based model resolution
- Redis session management

Architecture:
- agent.py: ChatAgent for agent creation and execution
- streaming_handler.py: ChatStreamingHandler for WebSocket/SSE streaming
- streaming/: Legacy streaming module (delegates to app.services.streaming)
- config/: Chat configuration builders
- agents/: LangGraph agent builders
- messages/: Message conversion utilities
- models/: LangChain model factory
- storage/: Unified storage handler
- tools/: Tool registry and implementations

The ChatService class is now a facade that delegates to:
- ChatAgent: For agent-related logic
- ChatStreamingHandler: For streaming logic
"""

import logging
from typing import Any

from fastapi.responses import StreamingResponse
from langchain_core.tools.base import BaseTool

from app.core.config import settings

from .agent import AgentConfig, ChatAgent, chat_agent
from .streaming_handler import ChatStreamingHandler, WebSocketStreamConfig

logger = logging.getLogger(__name__)


class ChatService:
    """Main service for chat completions.

    This service is a facade that delegates to:
    - ChatAgent: For agent creation, execution, and tool management
    - ChatStreamingHandler: For SSE and WebSocket streaming

    The service maintains the same public interface for backward compatibility
    while internally using a cleaner separation of concerns.
    """

    def __init__(
        self,
        workspace_root: str = "/workspace",
        enable_skills: bool = False,
        enable_web_search: bool = False,
        enable_checkpointing: bool = False,
    ):
        """Initialize Chat Service.

        Args:
            workspace_root: Root directory for file operations
            enable_skills: Enable built-in file skills
            enable_web_search: Enable web search tool (global default)
            enable_checkpointing: Enable state checkpointing
        """
        # Create the agent
        self._agent = ChatAgent(
            workspace_root=workspace_root,
            enable_skills=enable_skills,
            enable_web_search=enable_web_search,
            enable_checkpointing=enable_checkpointing,
        )

        # Create the streaming handler
        self._streaming_handler = ChatStreamingHandler(self._agent)

        # Expose tool registry for backward compatibility
        self.tool_registry = self._agent.tool_registry

    # ==================== SSE Streaming API ====================

    async def chat_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        subtask_id: int | None = None,
        task_id: int | None = None,
        is_group_chat: bool = False,
        max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS,
    ) -> StreamingResponse:
        """Stream chat response via SSE.

        Uses LangGraph's stream_tokens for token-level streaming.

        Args:
            message: User message (string or dict)
            model_config: Model configuration from ModelResolver
            system_prompt: System prompt
            subtask_id: Subtask ID (None for simple mode)
            task_id: Task ID (None for simple mode)
            is_group_chat: Whether this is a group chat
            max_iterations: Max tool loop iterations

        Returns:
            StreamingResponse with SSE events
        """
        return await self._streaming_handler.stream_sse(
            message=message,
            model_config=model_config,
            system_prompt=system_prompt,
            subtask_id=subtask_id,
            task_id=task_id,
            is_group_chat=is_group_chat,
            max_iterations=max_iterations,
        )

    # ==================== Non-Streaming API ====================

    async def chat_completion(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        history: list[dict[str, Any]] | None = None,
        max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS,
    ) -> dict[str, Any]:
        """Non-streaming chat completion using LangGraph agent.

        Args:
            message: User message
            model_config: Model configuration
            system_prompt: System prompt
            history: Optional chat history
            max_iterations: Max tool loop iterations

        Returns:
            Dict with content, tool_results, usage
        """
        # Build messages
        messages = self._agent.build_messages(
            history=history or [],
            current_message=message,
            system_prompt=system_prompt,
        )

        # Create agent config
        agent_config = AgentConfig(
            model_config=model_config,
            system_prompt=system_prompt,
            max_iterations=max_iterations,
            streaming=False,
        )

        # Execute agent
        return await self._agent.execute(messages, agent_config)

    # ==================== WebSocket Streaming API ====================

    async def stream_to_websocket(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        config: WebSocketStreamConfig,
        namespace: Any,
        max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS,
    ) -> None:
        """Stream chat response via WebSocket using StreamingCore.

        This method handles:
        - MCP tool loading and cleanup
        - Dynamic web search tool
        - Shutdown manager integration
        - WebSocket event emission (chat:chunk, chat:done, chat:error, chat:cancelled)

        Args:
            message: User message (string or dict)
            model_config: Model configuration from ModelResolver
            system_prompt: System prompt
            config: WebSocket streaming configuration
            namespace: ChatNamespace instance for emitting events
            max_iterations: Max tool loop iterations
        """
        await self._streaming_handler.stream_to_websocket(
            message=message,
            model_config=model_config,
            system_prompt=system_prompt,
            config=config,
            namespace=namespace,
            max_iterations=max_iterations,
        )

    # ==================== Tool Management ====================

    def list_tools(self) -> list[dict[str, Any]]:
        """List available tools in OpenAI format."""
        return self._agent.list_tools()


# Global service instance
chat_service = ChatService(
    workspace_root=getattr(settings, "WORKSPACE_ROOT", "/workspace"),
    enable_skills=getattr(settings, "ENABLE_SKILLS", True),
    enable_web_search=settings.WEB_SEARCH_ENABLED,
    enable_checkpointing=getattr(settings, "ENABLE_CHECKPOINTING", False),
)

# Re-export WebSocketStreamConfig for backward compatibility
__all__ = ["ChatService", "chat_service", "WebSocketStreamConfig"]
