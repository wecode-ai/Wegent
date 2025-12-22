# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph Chat Service - main service entry point.

This module provides a LangGraph-based chat service that uses:
- LangGraph StateGraph for agent workflow orchestration
- LangChain for model abstraction and tool binding
- Database-based model resolution
- Redis session management
- WebSocket event emission
- SSE streaming responses
"""

import asyncio
import json
import logging
from collections.abc import AsyncGenerator
from typing import Any

from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage

from app.core.config import settings

from .agents.graph_builder import LangGraphAgentBuilder
from .agents.state import AgentState
from .events import event_emitter
from .messages import MessageConverter
from .models import LangChainModelFactory
from .storage import storage_handler
from .tools import ToolRegistry, WebSearchTool

logger = logging.getLogger(__name__)

# SSE response headers
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
}

# Semaphore for concurrent chat limit
_chat_semaphore: asyncio.Semaphore | None = None


def _get_chat_semaphore() -> asyncio.Semaphore:
    """Get or create the chat semaphore for concurrency limiting."""
    global _chat_semaphore
    if _chat_semaphore is None:
        _chat_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CHATS)
    return _chat_semaphore


def _sse_data(data: dict) -> str:
    """Format data as SSE event."""
    return f"data: {json.dumps(data)}\n\n"


class LangGraphChatService:
    """Main service for LangGraph-based chat completions.

    This service uses LangGraph's StateGraph for orchestrating:
    - Model invocation (with tool binding)
    - Tool execution
    - Multi-step reasoning loops
    - Streaming with cancellation support
    """

    def __init__(
        self,
        workspace_root: str = "/workspace",
        enable_skills: bool = True,
        enable_web_search: bool = False,
        enable_checkpointing: bool = False,
    ):
        """Initialize LangGraph Chat Service.

        Args:
            workspace_root: Root directory for file operations
            enable_skills: Enable built-in file skills
            enable_web_search: Enable web search tool
            enable_checkpointing: Enable state checkpointing
        """
        self.workspace_root = workspace_root
        self.tool_registry = ToolRegistry()
        self.enable_checkpointing = enable_checkpointing

        # Register built-in skills
        if enable_skills:
            from .tools.builtin import FileListSkill, FileReaderSkill
            self.tool_registry.register(FileReaderSkill(workspace_root=workspace_root))
            self.tool_registry.register(FileListSkill(workspace_root=workspace_root))

        # Register web search if enabled
        if enable_web_search and settings.WEB_SEARCH_ENABLED:
            self.tool_registry.register(WebSearchTool())

    def _create_agent(
        self,
        model_config: dict[str, Any],
        max_iterations: int = 10,
        **model_kwargs,
    ) -> LangGraphAgentBuilder:
        """Create a LangGraph agent with the given model config.

        Args:
            model_config: Model configuration from database
            max_iterations: Max tool loop iterations
            **model_kwargs: Additional model parameters

        Returns:
            Configured LangGraphAgentBuilder instance
        """
        # Create LangChain model from config
        llm = LangChainModelFactory.create_from_config(model_config, **model_kwargs)

        # Create agent builder
        return LangGraphAgentBuilder(
            llm=llm,
            tool_registry=self.tool_registry,
            max_iterations=max_iterations,
            enable_checkpointing=self.enable_checkpointing,
        )

    # ==================== SSE Streaming API ====================

    async def chat_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        subtask_id: int | None = None,
        task_id: int | None = None,
        is_group_chat: bool = False,
        max_iterations: int = 10,
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
        is_simple_mode = subtask_id is None or task_id is None

        if is_simple_mode:
            return await self._simple_stream(message, model_config, system_prompt, max_iterations)

        return await self._full_stream(
            message=message,
            model_config=model_config,
            system_prompt=system_prompt,
            subtask_id=subtask_id,
            task_id=task_id,
            is_group_chat=is_group_chat,
            max_iterations=max_iterations,
        )

    async def _simple_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        max_iterations: int,
    ) -> StreamingResponse:
        """Simple streaming without database operations."""

        async def generate() -> AsyncGenerator[str, None]:
            try:
                # Build messages
                messages = MessageConverter.build_messages(
                    history=[],
                    current_message=message,
                    system_prompt=system_prompt,
                )

                # Create agent and stream
                agent = self._create_agent(model_config, max_iterations)

                async for token in agent.stream_tokens(messages):
                    yield _sse_data({"content": token, "done": False})

                yield _sse_data({"content": "", "done": True})

            except Exception as e:
                logger.exception("Simple stream error: %s", str(e))
                yield _sse_data({"error": str(e)})

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    async def _full_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        subtask_id: int,
        task_id: int,
        is_group_chat: bool,
        max_iterations: int,
    ) -> StreamingResponse:
        """Full streaming with database and session management."""
        semaphore = _get_chat_semaphore()

        async def generate() -> AsyncGenerator[str, None]:
            acquired = False
            cancel_event = await storage_handler.register_stream(subtask_id)

            try:
                # Acquire semaphore with timeout
                try:
                    acquired = await asyncio.wait_for(semaphore.acquire(), timeout=5.0)
                except asyncio.TimeoutError:
                    yield _sse_data({"error": "Too many concurrent chat requests"})
                    await storage_handler.update_subtask_status(
                        subtask_id, "FAILED", error="Too many concurrent chat requests"
                    )
                    return

                # Update status to RUNNING
                await storage_handler.update_subtask_status(subtask_id, "RUNNING")

                # Get chat history
                if is_group_chat:
                    history = await self._get_group_chat_history(task_id)
                    history = self._truncate_history(history)
                else:
                    history = await storage_handler.get_chat_history(task_id)

                # Build messages
                messages = MessageConverter.build_messages(history, message, system_prompt)

                # Create agent
                agent = self._create_agent(model_config, max_iterations)

                # Stream tokens using LangGraph
                full_response = ""
                last_redis_save = asyncio.get_event_loop().time()
                last_db_save = asyncio.get_event_loop().time()

                async for token in agent.stream_tokens(messages, cancel_event=cancel_event):
                    if cancel_event.is_set():
                        yield _sse_data({"content": "", "done": True, "cancelled": True})
                        await storage_handler.update_subtask_status(
                            subtask_id, "CANCELLED"
                        )
                        return

                    full_response += token
                    yield _sse_data({"content": token, "done": False})

                    # Periodic saves
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_redis_save >= settings.STREAMING_REDIS_SAVE_INTERVAL:
                        await storage_handler.save_streaming_content(subtask_id, full_response)
                        last_redis_save = current_time
                    if current_time - last_db_save >= settings.STREAMING_DB_SAVE_INTERVAL:
                        await storage_handler.save_partial_response(subtask_id, full_response)
                        last_db_save = current_time

                # Save final result
                result = {"value": full_response}
                await storage_handler.save_streaming_content(subtask_id, full_response)
                await storage_handler.publish_streaming_done(subtask_id, result)
                await storage_handler.append_messages(task_id, message, full_response)
                await storage_handler.update_subtask_status(subtask_id, "COMPLETED", result=result)

                yield _sse_data({"content": "", "done": True, "result": result})

            except Exception as e:
                logger.exception("[STREAM] subtask=%s error: %s", subtask_id, str(e))
                await storage_handler.update_subtask_status(subtask_id, "FAILED", error=str(e))
                yield _sse_data({"error": str(e)})

            finally:
                await storage_handler.unregister_stream(subtask_id)
                await storage_handler.delete_streaming_content(subtask_id)
                if acquired:
                    semaphore.release()

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )

    # ==================== Non-Streaming API ====================

    async def chat_completion(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        history: list[dict[str, Any]] | None = None,
        max_iterations: int = 10,
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
        messages = MessageConverter.build_messages(
            history=history or [],
            current_message=message,
            system_prompt=system_prompt,
        )

        agent = self._create_agent(model_config, max_iterations)
        final_state = await agent.execute(messages)

        content = agent.get_final_content(final_state)
        error = final_state.get("error")

        if error:
            raise RuntimeError(error)

        return {
            "content": content,
            "tool_results": final_state.get("tool_results", []),
            "iterations": final_state.get("iteration", 0),
        }

    # ==================== Helper Methods ====================

    async def _get_group_chat_history(self, task_id: int) -> list[dict[str, Any]]:
        """Get chat history for group chat from database."""
        from app.services.chat.chat_service import chat_service
        return await chat_service._get_group_chat_history(task_id)

    def _truncate_history(self, history: list[dict[str, str]]) -> list[dict[str, str]]:
        """Truncate chat history keeping first N and last M messages."""
        first_count = settings.GROUP_CHAT_HISTORY_FIRST_MESSAGES
        last_count = settings.GROUP_CHAT_HISTORY_LAST_MESSAGES
        total = len(history)

        if total <= first_count + last_count:
            return history

        return history[:first_count] + history[-last_count:]

    def list_tools(self) -> list[dict[str, Any]]:
        """List available tools in OpenAI format."""
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.args_schema.schema() if tool.args_schema else {},
                },
            }
            for tool in self.tool_registry.get_all()
        ]


# Global service instance
langgraph_chat_service = LangGraphChatService()
