# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SSE Streaming Handler for Chat Service.

This module provides the SSE streaming handler that:
- Handles simple streaming without database operations
- Handles full streaming with database and session management
"""

import json
import logging
from collections.abc import AsyncGenerator
from typing import Any

from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.services.streaming import (
    SSEEmitter,
    StreamingConfig,
    StreamingCore,
    StreamingState,
)

from ..agent import AgentConfig, ChatAgent
from ..history import get_chat_history
from ..tools.events import create_tool_event_handler

logger = logging.getLogger(__name__)


# SSE response headers
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
}


def _sse_data(data: dict[str, Any]) -> str:
    """Format data as SSE event."""
    return f"data: {json.dumps(data)}\n\n"


class SSEStreamingHandler:
    """Handler for chat streaming over SSE.

    This class bridges the ChatAgent with SSE streaming infrastructure:
    - Uses ChatAgent for agent execution
    - Uses streaming module for protocol handling
    - Handles tool event callbacks and thinking steps
    """

    def __init__(self, agent: ChatAgent):
        """Initialize SSE streaming handler.

        Args:
            agent: ChatAgent instance for agent operations
        """
        self.agent = agent

    async def stream_sse(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str = "",
        subtask_id: int | None = None,
        task_id: int | None = None,
        is_group_chat: bool = False,
        max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS,
        enable_clarification: bool = False,
        enable_deep_thinking: bool = True,
        skills: list[dict[str, Any]] | None = None,
    ) -> StreamingResponse:
        """Stream chat response via SSE.

        Args:
            message: User message (string or dict)
            model_config: Model configuration from ModelResolver
            system_prompt: Base system prompt (enhancements applied internally)
            subtask_id: Subtask ID (None for simple mode)
            task_id: Task ID (None for simple mode)
            is_group_chat: Whether this is a group chat
            max_iterations: Max tool loop iterations
            enable_clarification: Whether to enable clarification mode
            enable_deep_thinking: Whether to enable deep thinking mode
            skills: Skill metadata for prompt injection

        Returns:
            StreamingResponse with SSE events
        """
        is_simple_mode = subtask_id is None or task_id is None

        if is_simple_mode:
            return await self._simple_stream(
                message,
                model_config,
                system_prompt,
                max_iterations,
                enable_clarification=enable_clarification,
                enable_deep_thinking=enable_deep_thinking,
                skills=skills,
            )

        return await self._full_stream(
            message=message,
            model_config=model_config,
            system_prompt=system_prompt,
            subtask_id=subtask_id,
            task_id=task_id,
            is_group_chat=is_group_chat,
            max_iterations=max_iterations,
            enable_clarification=enable_clarification,
            enable_deep_thinking=enable_deep_thinking,
            skills=skills,
        )

    async def _simple_stream(
        self,
        message: str | dict[str, Any],
        model_config: dict[str, Any],
        system_prompt: str,
        max_iterations: int,
        enable_clarification: bool = False,
        enable_deep_thinking: bool = False,
        skills: list[dict[str, Any]] | None = None,
    ) -> StreamingResponse:
        """Simple streaming without database operations."""

        async def generate() -> AsyncGenerator[str, None]:
            try:
                # Create agent config with prompt enhancement options
                agent_config = AgentConfig(
                    model_config=model_config,
                    system_prompt=system_prompt,
                    max_iterations=max_iterations,
                    enable_clarification=enable_clarification,
                    enable_deep_thinking=enable_deep_thinking,
                    skills=skills,
                )

                # Build messages (prompt enhancements applied internally based on config)
                messages = self.agent.build_messages(
                    history=[],
                    current_message=message,
                    system_prompt=system_prompt,
                    config=agent_config,
                )

                async for token in self.agent.stream(messages, agent_config):
                    yield _sse_data({"content": token, "done": False})

                yield _sse_data({"content": "", "done": True})

            except Exception as e:
                logger.exception("Simple stream error")
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
        user_message_id: int | None = None,
        enable_clarification: bool = False,
        enable_deep_thinking: bool = False,
        skills: list[dict[str, Any]] | None = None,
    ) -> StreamingResponse:
        """Full streaming with database and session management using StreamingCore.

        Args:
            user_message_id: Current user's message_id, used to exclude it from history
                            (the user message will be added by build_messages())
            enable_clarification: Whether to enable clarification mode
            enable_deep_thinking: Whether to enable deep thinking mode
            skills: Skill metadata for prompt injection
        """

        async def generate() -> AsyncGenerator[str, None]:
            # Create SSE emitter
            emitter = SSEEmitter()

            # Create streaming state
            state = StreamingState(
                task_id=task_id,
                subtask_id=subtask_id,
                user_id=0,  # Not needed for SSE
                is_group_chat=is_group_chat,
            )

            # Create streaming core
            core = StreamingCore(emitter, state, StreamingConfig())

            try:
                # Acquire resources
                if not await core.acquire_resources():
                    # Error already emitted by core
                    if emitter.has_events():
                        yield emitter.get_event()
                    return

                # Get chat history (exclude current user message to avoid duplication)
                # The current user message will be added by build_messages()
                history = await get_chat_history(
                    task_id, is_group_chat, exclude_after_message_id=user_message_id
                )

                # Create agent config with prompt enhancement options
                agent_config = AgentConfig(
                    model_config=model_config,
                    system_prompt=system_prompt,
                    max_iterations=max_iterations,
                    enable_clarification=enable_clarification,
                    enable_deep_thinking=enable_deep_thinking,
                    skills=skills,
                )

                # Build messages (prompt enhancements applied internally based on config)
                messages = self.agent.build_messages(
                    history, message, system_prompt, config=agent_config
                )

                # Create tool event handler
                handle_tool_event = create_tool_event_handler(
                    state, emitter, self.agent.create_agent_builder(agent_config)
                )

                # Stream tokens
                async for token in self.agent.stream(
                    messages,
                    agent_config,
                    cancel_event=core.cancel_event,
                    on_tool_event=handle_tool_event,
                ):
                    if not await core.process_token(token):
                        # Cancelled
                        if emitter.has_events():
                            yield emitter.get_event()
                        return

                    # Yield any pending events
                    while emitter.has_events():
                        yield emitter.get_event()

                # Finalize
                await core.finalize()

                # Yield final events
                while emitter.has_events():
                    yield emitter.get_event()

            except Exception as e:
                logger.exception("[STREAM] subtask=%s error", subtask_id)
                await core.handle_error(e)
                while emitter.has_events():
                    yield emitter.get_event()

            finally:
                await core.release_resources()

        return StreamingResponse(
            generate(), media_type="text/event-stream", headers=_SSE_HEADERS
        )
