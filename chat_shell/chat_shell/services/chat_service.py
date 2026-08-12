# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Service - Main entry point for chat operations.

This service handles:
- Chat message processing with streaming SSE responses
- Resume functionality for reconnection
- Cancellation support
- Integration with LangGraph-based ChatAgent

Architecture:
- API layer creates transport/emitter and passes to ChatService
- ChatService uses the emitter directly for streaming events to SSE
- Single layer of event emission, no intermediate conversion

Uses unified ResponsesAPIEmitter from shared module for event emission.
"""

import asyncio
import hashlib
import json
import logging
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator

from chat_shell.compression.context_metrics import (
    PHASE_BUILD_MESSAGES,
    PHASE_FINAL,
    ContextMetricsTracker,
)
from chat_shell.core.config import settings
from chat_shell.llm_logging import env_bool
from chat_shell.services.context import ChatContext
from chat_shell.services.guidance import GuidanceConsumer, create_guidance_queue_client
from chat_shell.services.storage.session import session_manager
from chat_shell.services.streaming.core import (
    StreamingConfig,
    StreamingCore,
    StreamingState,
)
from chat_shell.tools.builtin.silent_exit import SilentExitException
from chat_shell.tools.deferred_input import DeferredUserInputExit
from chat_shell.tools.events import create_tool_event_handler
from shared.models import ResponsesAPIEmitter
from shared.models.execution import EventType, ExecutionEvent, ExecutionRequest
from shared.telemetry.decorators import add_span_event, trace_async

logger = logging.getLogger(__name__)

E2E_LOG_ENV = "PROVIDER_NATIVE_E2E_LOGGING"
_E2E_SAFE_TOOL_ARGUMENTS = frozenset(
    {
        "knowledge_base_id",
        "knowledge_base_ids",
        "folder_id",
        "folder_ids",
        "include_subfolders",
        "document_id",
        "document_ids",
        "nodeId",
        "node_id",
        "workspaceId",
        "workspace_id",
        "parent_id",
        "scope",
        "limit",
        "offset",
    }
)


def _provider_native_e2e_logging_enabled() -> bool:
    return env_bool(E2E_LOG_ENV, default=False)


def _log_provider_native_e2e(event: str, **details: Any) -> None:
    if not _provider_native_e2e_logging_enabled():
        return
    logger.info(
        "[PROVIDER_NATIVE_E2E] %s",
        json.dumps({"event": event, **details}, ensure_ascii=False, sort_keys=True),
    )


def _safe_tool_scope(event_data: dict[str, Any]) -> dict[str, Any]:
    data = event_data.get("data")
    tool_input = data.get("input") if isinstance(data, dict) else None
    if not isinstance(tool_input, dict):
        return {}
    return {
        key: value
        for key, value in tool_input.items()
        if key in _E2E_SAFE_TOOL_ARGUMENTS
        and isinstance(value, (str, int, float, bool, list, type(None)))
    }


def _resolve_final_context_metric_messages(
    *,
    initial_messages: list[dict[str, Any]],
    messages_chain: list[dict[str, Any]] | None,
    live_state_messages: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Resolve the best available final model-visible state for metrics.

    Phase 2 guard enforcement mutates LangGraph live state mid-turn. When the
    agent builder captured that final state, prefer it over reconstructing an
    approximation from the turn input plus serialized turn output.
    """
    if live_state_messages:
        return list(live_state_messages)
    return list(initial_messages) + list(messages_chain or [])


class ChatInterface(ABC):
    """Abstract interface for Chat Shell operations."""

    @abstractmethod
    async def chat(
        self,
        request: ExecutionRequest,
        emitter: ResponsesAPIEmitter,
    ) -> None:
        """Process a chat request and stream events via emitter.

        Args:
            request: Execution request data
            emitter: ResponsesAPIEmitter for streaming events directly to SSE
        """
        pass

    @abstractmethod
    async def resume(
        self, subtask_id: int, offset: int = 0
    ) -> AsyncIterator[ExecutionEvent]:
        """Resume a streaming session from a given offset."""
        pass

    @abstractmethod
    async def cancel(self, subtask_id: int) -> bool:
        """Cancel an ongoing chat request."""
        pass


class ChatService(ChatInterface):
    """Chat service implementing the unified ChatInterface.

    This service provides the full chat functionality for Chat Shell,
    including streaming responses, tool execution, and cancellation.

    Events are streamed directly via the emitter passed from API layer.
    """

    def __init__(self):
        """Initialize chat service."""
        self._storage = session_manager

    def _build_dynamic_context(self, request: ExecutionRequest, ctx_result: Any) -> str:
        """Build dynamic context string for injection before current message.

        This method aggregates all dynamic content that should be injected
        as a human message before the current user message. This enables
        better prompt caching by keeping system prompts static.

        Currently includes:
        - request.kb_meta_prompt: Knowledge base metadata (names, IDs, summaries)

        Internal extensions may add:
        - weibo_context: User identity context (internal network only)
        """
        parts: list[str] = []

        selected_knowledge_prompt = getattr(request, "selected_knowledge_prompt", "")
        if selected_knowledge_prompt:
            parts.append(selected_knowledge_prompt)

        # Prefer Backend-provided kb_meta_prompt (HTTP mode).
        if request.kb_meta_prompt:
            parts.append(request.kb_meta_prompt)

        # Fallback to ctx_result (package mode).
        kb_meta_prompt = getattr(ctx_result, "kb_meta_prompt", "")
        if kb_meta_prompt and kb_meta_prompt not in parts:
            parts.append(kb_meta_prompt)

        # History-backtracking nudge (only set once compaction has dropped detail).
        backtrack_hint = getattr(ctx_result, "backtrack_hint", "")
        if backtrack_hint:
            parts.append(backtrack_hint)

        return "\n\n".join(parts) if parts else ""

    @trace_async(
        span_name="chat_service.chat",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, request, emitter, *args, **kwargs: {
            "chat.task_id": request.task_id,
            "chat.subtask_id": request.subtask_id,
            "chat.user_id": request.user_id,
            "chat.user_name": request.user_name or "",
            "chat.is_group_chat": request.is_group_chat,
        },
    )
    async def chat(
        self,
        request: ExecutionRequest,
        emitter: ResponsesAPIEmitter,
    ) -> None:
        """Process a chat request and stream events via emitter.

        Args:
            request: Execution request data
            emitter: ResponsesAPIEmitter for streaming events directly to SSE
        """
        add_span_event("chat_started", {"task_id": request.task_id})

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
                add_span_event("resources_acquisition_failed")
                logger.warning("[CHAT_SERVICE] Failed to acquire resources!")
                return

            add_span_event("resources_acquired")
            logger.debug("[CHAT_SERVICE] Resources acquired, processing chat...")

            # Process chat with the agent
            add_span_event("processing_chat_started")
            await self._process_chat(request, core, state, emitter)
            add_span_event("processing_chat_completed")

        except asyncio.CancelledError:
            # Surface cancellation (client disconnect, upstream timeout, shutdown)
            # explicitly — the ``except Exception`` below cannot see it.
            logger.warning(
                "[CHAT_SERVICE] chat() cancelled: task_id=%s subtask_id=%s",
                request.task_id,
                request.subtask_id,
            )
            raise
        except Exception as e:
            add_span_event("chat_error", {"error": str(e)})
            logger.exception(
                "[CHAT_SERVICE] Exception in chat(): type=%s",
                type(e).__name__,
            )
            await core.handle_error(e)
        finally:
            add_span_event("releasing_resources")
            logger.debug("[CHAT_SERVICE] Releasing resources...")
            await core.release_resources()
            add_span_event("resources_released")

    @trace_async(
        span_name="chat_service.process_chat",
        tracer_name="chat_shell.services",
        extract_attributes=lambda self, request, core, state, emitter, *args, **kwargs: {
            "process.task_id": request.task_id,
            "process.subtask_id": request.subtask_id,
            "process.model_id": (
                request.model_config.get("model_id")
                if request.model_config
                else "gpt-4"
            ),
            "process.model_provider": (
                request.model_config.get("model") if request.model_config else "openai"
            ),
        },
    )
    async def _process_chat(
        self,
        request: ExecutionRequest,
        core: StreamingCore,
        state: StreamingState,
        emitter: ResponsesAPIEmitter,
    ) -> None:
        """Process chat request with agent streaming."""
        import time

        from chat_shell import AgentConfig, create_chat_agent

        add_span_event("process_chat_started", {"task_id": request.task_id})

        # Create chat context for resource management
        context = ChatContext(request)
        guidance_consumer: GuidanceConsumer | None = None

        try:
            logger.debug(
                "[CHAT_SERVICE] Processing chat: task_id=%d, subtask_id=%d",
                request.task_id,
                request.subtask_id,
            )
            context_metrics_tracker: ContextMetricsTracker | None = None

            # The prompt advertises attachment paths inside the task sandbox.
            # Materialize those files before the model can call sandbox tools so
            # a newly-created sandbox cannot race the upload-time best-effort sync.
            from chat_shell.services.sandbox_attachment_sync import (
                sync_chat_attachments_to_sandbox,
            )

            add_span_event("syncing_sandbox_attachments")
            await sync_chat_attachments_to_sandbox(request)

            # Prepare all context resources in parallel
            add_span_event("preparing_context")
            t0 = time.perf_counter()
            ctx_result = await context.prepare()
            logger.info(
                "[CHAT_SERVICE_PERF] context.prepare: %.2fms",
                (time.perf_counter() - t0) * 1000,
            )

            # Create chat agent
            add_span_event("creating_chat_agent")
            agent = create_chat_agent(
                workspace_root=settings.WORKSPACE_ROOT,
                enable_skills=settings.ENABLE_SKILLS,
                enable_web_search=False,
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

            guidance_consumer = GuidanceConsumer(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                queue=create_guidance_queue_client(),
                emitter=emitter,
                is_cancelled=core.is_cancelled,
            )

            # Build the unified context guard that runs as the LangGraph
            # pre_model_hook. It owns budget enforcement at every model call —
            # both pre-turn (turn start) and mid-turn (after every tool). The
            # guidance consumer's hook is chained AFTER the guard so guidance
            # injection observes already-budgeted state.
            from chat_shell.compression.config import get_model_context_config
            from chat_shell.compression.summary_compactor import (
                DEFAULT_RECENT_USER_TOKEN_LIMIT,
                SummaryCompactor,
            )
            from chat_shell.compression.token_counter import TokenCounter
            from chat_shell.guard import (
                ToolOutputGuardAdapter,
                TruncationPolicy,
                UnifiedContextGuard,
                chain_pre_model_hooks,
            )
            from chat_shell.models.factory import LangChainModelFactory

            guard_model_id = (
                request.model_config.get("model_id") if request.model_config else None
            ) or "gpt-4"
            guard_model_type = (
                request.model_config.get("model") if request.model_config else None
            )
            guard_counter = TokenCounter(
                model_name=guard_model_id, model_type=guard_model_type
            )
            guard_sources = []
            if not settings.DISABLE_TOOL_OUTPUT_GUARD:
                tool_output_adapter = ToolOutputGuardAdapter(
                    token_counter=guard_counter,
                    default_policy=TruncationPolicy(
                        kind="tokens", limit=settings.TOOL_OUTPUT_TOKEN_LIMIT
                    ),
                    emergency_ratio=settings.EMERGENCY_TOOL_OUTPUT_RATIO,
                )
                guard_sources = [tool_output_adapter]
            summary_compactor = None
            if (
                settings.MESSAGE_COMPRESSION_ENABLED
                and not settings.DISABLE_SUMMARY_COMPACT
            ):
                summary_llm = LangChainModelFactory.create_from_config(
                    request.model_config
                    or {
                        "model_id": guard_model_id,
                        "model": guard_model_type or "openai",
                    },
                    streaming=False,
                    request_timeout=240,
                )
                context_config = get_model_context_config(
                    guard_model_id,
                    model_config=request.model_config,
                )
                summary_compactor = SummaryCompactor(
                    llm=summary_llm,
                    token_counter=guard_counter,
                    recent_user_token_limit=min(
                        DEFAULT_RECENT_USER_TOKEN_LIMIT,
                        max(1, int(context_config.target_limit * 0.5)),
                    ),
                    max_compact_input_tokens=context_config.target_limit,
                    request_timeout=240,
                )
            context_guard = UnifiedContextGuard(
                model_id=guard_model_id,
                model_type=guard_model_type,
                model_config=request.model_config,
                sources=guard_sources,
                compression_enabled=settings.MESSAGE_COMPRESSION_ENABLED,
                summary_compactor=summary_compactor,
            )
            chained_pre_model_hook = chain_pre_model_hooks(
                context_guard,
                guidance_consumer.create_pre_model_hook(),
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
                pre_model_hook=chained_pre_model_hook,
            )

            # Build messages for the agent
            add_span_event("building_messages")
            model_id = (
                request.model_config.get("model_id") if request.model_config else None
            )
            dynamic_context = self._build_dynamic_context(request, ctx_result)
            if request.provider_native_knowledge:
                selected_prompt = request.selected_knowledge_prompt or ""
                tool_names = sorted(
                    tool.name
                    for tool in ctx_result.extra_tools
                    if hasattr(tool, "name")
                )
                _log_provider_native_e2e(
                    "chat_runtime_ready",
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    provider_native_knowledge=True,
                    selected_prompt_length=len(selected_prompt),
                    selected_prompt_sha256=hashlib.sha256(
                        selected_prompt.encode("utf-8")
                    ).hexdigest(),
                    selected_prompt_in_dynamic_context=(
                        bool(selected_prompt) and selected_prompt in dynamic_context
                    ),
                    tool_names=tool_names,
                    legacy_knowledge_search_present="knowledge_search" in tool_names,
                )
            t1 = time.perf_counter()
            messages = agent.build_messages(
                history=ctx_result.history,
                current_message=request.prompt,
                system_prompt=ctx_result.system_prompt,
                username=request.user_name if request.is_group_chat else None,
                config=agent_config,
                model_id=model_id,
                dynamic_context=dynamic_context,
                model_config=request.model_config,
            )
            logger.info(
                "[CHAT_SERVICE_PERF] build_messages: %.2fms",
                (time.perf_counter() - t1) * 1000,
            )
            add_span_event("messages_built", {"message_count": len(messages)})

            context_metrics_tracker = ContextMetricsTracker(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                metrics_fn=context_guard.metrics,
                emitter=emitter,
            )
            # Wire the tracker into the guard so every pre_model_hook
            # invocation (turn start + after each tool) emits a snapshot
            # via the same tracker. This restores the per-tool toolbar
            # updates from Phase 1 while sourcing accounting from the
            # guard's authoritative state.
            context_guard.set_tracker(context_metrics_tracker)
            agent_config.on_model_usage = context_metrics_tracker.record_provider_usage
            initial_snapshot = await context_metrics_tracker.capture(
                messages, PHASE_BUILD_MESSAGES
            )
            state.context_metrics = initial_snapshot.to_dict()

            # Persist the formatted user message (with system-reminder time block) to
            # the DB so that future turns load the same exact content, enabling
            # prefix-cache hits.  We do this only when datetime was injected
            # (enable_deep_thinking=True) and the user subtask ID is known.
            # This is best-effort: a transient failure should not abort streaming.
            if request.enable_deep_thinking and request.user_subtask_id:
                last_msg_content = messages[-1].get("content") if messages else None
                if isinstance(last_msg_content, list):
                    try:
                        from chat_shell.history import update_user_message_content

                        await update_user_message_content(
                            task_id=request.task_id,
                            user_subtask_id=request.user_subtask_id,
                            content=last_msg_content,
                        )
                    except Exception:
                        logger.warning(
                            "Failed to persist formatted user message for "
                            "prefix-cache optimization (task_id=%s, subtask_id=%s)",
                            request.task_id,
                            request.user_subtask_id,
                            exc_info=True,
                        )

            # Create tool event handler
            add_span_event("creating_tool_event_handler")
            t2 = time.perf_counter()
            agent_builder = agent.create_agent_builder(agent_config)
            base_tool_event_handler = create_tool_event_handler(
                state,
                emitter,
                agent_builder,
            )

            def on_tool_event(kind: str, event_data: dict[str, Any]) -> None:
                if request.provider_native_knowledge and kind in {
                    "tool_start",
                    "tool_end",
                }:
                    _log_provider_native_e2e(
                        (
                            "tool_call_started"
                            if kind == "tool_start"
                            else "tool_call_ended"
                        ),
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        tool_name=event_data.get("name", "unknown"),
                        scope_arguments=(
                            _safe_tool_scope(event_data) if kind == "tool_start" else {}
                        ),
                    )
                base_tool_event_handler(kind, event_data)

            logger.info(
                "[CHAT_SERVICE_PERF] create_agent_builder: %.2fms",
                (time.perf_counter() - t2) * 1000,
            )

            # Stream tokens from agent
            add_span_event("streaming_started")
            token_count = 0
            try:
                async for token in agent.stream(
                    messages=messages,
                    config=agent_config,
                    cancel_event=core.cancel_event,
                    on_tool_event=on_tool_event,
                    agent_builder=agent_builder,
                ):
                    if core.is_cancelled():
                        add_span_event(
                            "streaming_cancelled", {"tokens_processed": token_count}
                        )
                        break

                    if not await core.process_token(token):
                        add_span_event(
                            "token_processing_stopped",
                            {"tokens_processed": token_count},
                        )
                        break

                    token_count += 1

            except SilentExitException as e:
                logger.info(
                    "[CHAT_SERVICE] Silent exit requested: subtask_id=%d, reason=%s",
                    request.subtask_id,
                    e.reason,
                )
                add_span_event(
                    "silent_exit_requested",
                    {"reason": e.reason, "tokens_processed": token_count},
                )
                state.is_silent_exit = True
                state.silent_exit_reason = e.reason
            except DeferredUserInputExit:
                logger.info(
                    "[CHAT_SERVICE] Deferred user input requested: subtask_id=%d",
                    request.subtask_id,
                )
                add_span_event(
                    "deferred_user_input_requested",
                    {"tokens_processed": token_count},
                )
                state.is_silent_exit = True
                state.silent_exit_reason = "waiting_for_user_input"
                state.is_deferred_user_input = True

            # Transfer messages chain from agent builder to streaming state
            messages_chain = getattr(agent_builder, "_last_messages_chain", None)
            if messages_chain:
                state.messages_chain = messages_chain
            termination_reason = getattr(
                agent_builder, "_last_termination_reason", None
            )
            if termination_reason:
                state.termination_reason = termination_reason
            if context_guard.context_compactions:
                state.context_compactions = context_guard.context_compactions

            # Finalize if not cancelled
            await guidance_consumer.expire_pending()
            if not core.is_cancelled():
                if context_metrics_tracker is not None:
                    final_messages = _resolve_final_context_metric_messages(
                        initial_messages=messages,
                        messages_chain=messages_chain,
                        live_state_messages=getattr(
                            agent_builder, "_last_live_state_messages", None
                        ),
                    )
                    final_snapshot = await context_metrics_tracker.capture(
                        final_messages, PHASE_FINAL
                    )
                    state.context_metrics = final_snapshot.to_dict()
                add_span_event("finalizing", {"total_tokens": token_count})
                await core.finalize()

            add_span_event("streaming_completed", {"total_tokens": token_count})

        except Exception as e:
            add_span_event("process_chat_error", {"error": str(e)})
            logger.exception("[CHAT_SERVICE] Error processing chat: %s", e)
            raise
        finally:
            if guidance_consumer is not None:
                await guidance_consumer.expire_pending()
            add_span_event("cleaning_up_context")
            await context.cleanup()
            add_span_event("context_cleaned_up")

    async def resume(
        self, subtask_id: int, offset: int = 0
    ) -> AsyncIterator[ExecutionEvent]:
        """Resume a streaming session from a given offset."""
        logger.info(
            "[CHAT_SERVICE] Resuming stream: subtask_id=%d, offset=%d",
            subtask_id,
            offset,
        )

        cached_content = await self._storage.get_streaming_content(subtask_id)

        if cached_content and offset < len(cached_content):
            remaining = cached_content[offset:]
            yield ExecutionEvent(
                type=EventType.CHUNK.value,
                content=remaining,
                offset=offset,
                subtask_id=subtask_id,
            )

    async def cancel(self, subtask_id: int) -> bool:
        """Cancel an ongoing chat request."""
        logger.info(
            "[CHAT_SERVICE] Cancelling stream: subtask_id=%d",
            subtask_id,
        )
        return await self._storage.cancel_stream(subtask_id)


# Global chat service instance
chat_service = ChatService()
