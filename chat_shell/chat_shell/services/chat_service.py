# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Service - Main entry point for chat operations.

This service handles:
- Chat message processing with streaming SSE responses
- Resume functionality for reconnection
- Cancellation support
- Integration with LangGraph-based ChatAgent
"""

import logging
from typing import AsyncIterator

from shared.telemetry.decorators import add_span_event, trace_async_generator

from chat_shell.core.config import settings
from chat_shell.interface import ChatEvent, ChatEventType, ChatInterface, ChatRequest
from chat_shell.services.context import ChatContext
from chat_shell.services.storage.session import session_manager
from chat_shell.services.streaming.core import (
    StreamingConfig,
    StreamingCore,
    StreamingState,
)
from chat_shell.services.streaming.emitters import SSEEmitter
from chat_shell.tools.events import create_tool_event_handler

logger = logging.getLogger(__name__)


class ChatService(ChatInterface):
    """Chat service implementing the unified ChatInterface.

    This service provides the full chat functionality for Chat Shell,
    including streaming responses, tool execution, and cancellation.
    """

    def __init__(self):
        """Initialize chat service."""
        self._storage = session_manager

    @trace_async_generator(
        span_name="chat_service.chat",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, request, *args, **kwargs: {
            "chat.task_id": request.task_id,
            "chat.subtask_id": request.subtask_id,
            "chat.user_id": request.user_id,
            "chat.user_name": request.user_name or "",
            "chat.is_group_chat": request.is_group_chat,
        },
    )
    async def chat(self, request: ChatRequest) -> AsyncIterator[ChatEvent]:
        """Process a chat request and stream events.

        Args:
            request: Chat request data

        Yields:
            ChatEvent: Events during chat processing
        """
        add_span_event("chat_started", {"task_id": request.task_id})

        emitter = SSEEmitter()
        state = StreamingState(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            user_id=request.user_id,
            user_name=request.user_name,
            is_group_chat=request.is_group_chat,
            message_id=request.message_id,
            shell_type="Chat",
        )

        core = StreamingCore(
            emitter=emitter,
            state=state,
            config=StreamingConfig(),
            storage_handler=self._storage,
        )

        try:
            # Acquire resources
            add_span_event("acquiring_resources")
            logger.debug("[CHAT_SERVICE] Acquiring resources...")
            if not await core.acquire_resources():
                # Emit error event if resources couldn't be acquired
                add_span_event("resources_acquisition_failed")
                logger.warning("[CHAT_SERVICE] Failed to acquire resources!")
                async for event in self._emit_pending_events(emitter):
                    yield event
                return

            add_span_event("resources_acquired")
            logger.debug("[CHAT_SERVICE] Resources acquired, emitting start event...")
            # Emit start event
            async for event in self._emit_pending_events(emitter):
                yield event

            # Process chat with the agent
            add_span_event("processing_chat_started")
            logger.debug("[CHAT_SERVICE] Starting _process_chat...")
            async for event in self._process_chat(request, core, state, emitter):
                yield event

            add_span_event("processing_chat_completed")

        except Exception as e:
            add_span_event("chat_error", {"error": str(e)})
            logger.exception("[CHAT_SERVICE] Exception in chat(): %s", e)
            await core.handle_error(e)
            async for event in self._emit_pending_events(emitter):
                yield event
        finally:
            add_span_event("releasing_resources")
            logger.debug("[CHAT_SERVICE] Releasing resources...")
            await core.release_resources()
            add_span_event("resources_released")

    @trace_async_generator(
        span_name="chat_service.process_chat",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, request, core, state, emitter, *args, **kwargs: {
            "process.task_id": request.task_id,
            "process.subtask_id": request.subtask_id,
            "process.model": (
                request.model_config.get("model") if request.model_config else "gpt-4"
            ),
        },
    )
    async def _process_chat(
        self,
        request: ChatRequest,
        core: StreamingCore,
        state: StreamingState,
        emitter: SSEEmitter,
    ) -> AsyncIterator[ChatEvent]:
        """Process chat request with agent streaming."""
        import time

        from chat_shell import AgentConfig, create_chat_agent

        add_span_event("process_chat_started", {"task_id": request.task_id})

        # Create chat context for resource management
        context = ChatContext(request)

        try:
            logger.debug(
                "[CHAT_SERVICE] Processing chat: task_id=%d, subtask_id=%d",
                request.task_id,
                request.subtask_id,
            )

            # Prepare all context resources in parallel
            add_span_event("preparing_context")
            t0 = time.perf_counter()
            ctx_result = await context.prepare()
            logger.info(
                "[CHAT_SERVICE_PERF] context.prepare: %.2fms",
                (time.perf_counter() - t0) * 1000,
            )

            # Create chat agent (agent creation belongs to service layer, not context)
            add_span_event("creating_chat_agent")
            agent = create_chat_agent(
                workspace_root=settings.WORKSPACE_ROOT,
                enable_skills=settings.ENABLE_SKILLS,
                enable_web_search=False,
                enable_checkpointing=settings.ENABLE_CHECKPOINTING,
            )

            add_span_event(
                "context_prepared",
                {
                    "history_count": len(ctx_result.history),
                    "extra_tools_count": len(ctx_result.extra_tools),
                },
            )
            logger.debug(
                "[CHAT_SERVICE] Context prepared: history=%d, extra_tools=%d",
                len(ctx_result.history),
                len(ctx_result.extra_tools),
            )

            # Build agent configuration
            if ctx_result.extra_tools:
                logger.debug(
                    "[CHAT_SERVICE] Extra tools: %s",
                    [t.name for t in ctx_result.extra_tools],
                )

            add_span_event("building_agent_config")
            agent_config = AgentConfig(
                model_config=request.model_config or {"model": "gpt-4"},
                system_prompt=ctx_result.system_prompt,
                max_iterations=settings.CHAT_TOOL_MAX_REQUESTS,
                extra_tools=ctx_result.extra_tools if ctx_result.extra_tools else None,
                streaming=True,
                enable_clarification=request.enable_clarification,
                enable_deep_thinking=request.enable_deep_thinking,
                skills=request.skills,
            )

            # Build messages for the agent
            add_span_event("building_messages")
            model_id = (
                request.model_config.get("model") if request.model_config else None
            )
            t1 = time.perf_counter()
            messages = agent.build_messages(
                history=ctx_result.history,
                current_message=request.message,
                system_prompt=ctx_result.system_prompt,
                username=request.user_name if request.is_group_chat else None,
                config=agent_config,
                model_id=model_id,
            )
            logger.info(
                "[CHAT_SERVICE_PERF] build_messages: %.2fms",
                (time.perf_counter() - t1) * 1000,
            )
            add_span_event("messages_built", {"message_count": len(messages)})

            # Create tool event handler using the agent builder
            add_span_event("creating_tool_event_handler")
            t2 = time.perf_counter()
            agent_builder = agent.create_agent_builder(agent_config)

            on_tool_event = create_tool_event_handler(state, emitter, agent_builder)
            logger.debug(
                "[CHAT_SERVICE] Created tool event handler, agent_builder=%s",
                type(agent_builder).__name__,
            )
            logger.info(
                "[CHAT_SERVICE_PERF] create_agent_builder: %.2fms",
                (time.perf_counter() - t2) * 1000,
            )

            # Stream tokens from agent, reusing the agent_builder we already created
            add_span_event("streaming_started")
            token_count = 0
            async for token in agent.stream(
                messages=messages,
                config=agent_config,
                cancel_event=core.cancel_event,
                on_tool_event=on_tool_event,
                agent_builder=agent_builder,  # Reuse to avoid duplicate creation
            ):
                if core.is_cancelled():
                    add_span_event(
                        "streaming_cancelled", {"tokens_processed": token_count}
                    )
                    break

                if not await core.process_token(token):
                    add_span_event(
                        "token_processing_stopped", {"tokens_processed": token_count}
                    )
                    break

                token_count += 1
                # Yield any pending events
                async for event in self._emit_pending_events(emitter):
                    yield event

            # Finalize if not cancelled
            if not core.is_cancelled():
                add_span_event("finalizing", {"total_tokens": token_count})
                await core.finalize()

            add_span_event("streaming_completed", {"total_tokens": token_count})

            # Yield remaining events
            async for event in self._emit_pending_events(emitter):
                yield event

        except Exception as e:
            add_span_event("process_chat_error", {"error": str(e)})
            logger.exception("[CHAT_SERVICE] Error processing chat: %s", e)
            raise
        finally:
            # Clean up context resources
            add_span_event("cleaning_up_context")
            await context.cleanup()
            add_span_event("context_cleaned_up")

    async def _emit_pending_events(
        self, emitter: SSEEmitter
    ) -> AsyncIterator[ChatEvent]:
        """Convert SSE emitter events to ChatEvents."""
        import json

        events = emitter.get_all_events()
        if events:
            logger.debug(
                "[CHAT_SERVICE] _emit_pending_events: got %d events", len(events)
            )
        for sse_data in events:
            # Parse SSE data line
            if sse_data.startswith("data: "):
                json_str = sse_data[6:].strip()
                if json_str:
                    try:
                        data = json.loads(json_str)
                        event_type = data.pop("type", "chunk")
                        yield ChatEvent(
                            type=ChatEventType(event_type),
                            data=data,
                        )
                    except json.JSONDecodeError:
                        continue

    async def resume(
        self, subtask_id: int, offset: int = 0
    ) -> AsyncIterator[ChatEvent]:
        """Resume a streaming session from a given offset.

        Args:
            subtask_id: Subtask ID to resume
            offset: Character offset to resume from

        Yields:
            ChatEvent: Events from the resumed position
        """
        logger.info(
            "[CHAT_SERVICE] Resuming stream: subtask_id=%d, offset=%d",
            subtask_id,
            offset,
        )

        # Get cached content from Redis
        cached_content = await self._storage.get_streaming_content(subtask_id)

        if cached_content and offset < len(cached_content):
            # Send remaining cached content
            remaining = cached_content[offset:]
            yield ChatEvent(
                type=ChatEventType.CHUNK,
                data={
                    "content": remaining,
                    "offset": offset,
                    "subtask_id": subtask_id,
                },
            )

        # Subscribe to streaming channel for real-time updates
        # This would be implemented with Redis Pub/Sub in the full version

    async def cancel(self, subtask_id: int) -> bool:
        """Cancel an ongoing chat request.

        Args:
            subtask_id: Subtask ID to cancel

        Returns:
            bool: True if cancellation was successful
        """
        logger.info(
            "[CHAT_SERVICE] Cancelling stream: subtask_id=%d",
            subtask_id,
        )

        return await self._storage.cancel_stream(subtask_id)


# Global chat service instance
chat_service = ChatService()
