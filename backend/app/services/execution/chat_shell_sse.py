# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0


"""Chat Shell SSE dispatch, cancellation and error notification."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any, Optional

from shared.models import (
    EventType,
    ExecutionEvent,
    ExecutionRequest,
    OpenAIRequestConverter,
)
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.telemetry.context import request_context
from shared.telemetry.decorators import add_span_event

from .chat_shell_client import (
    chat_shell_clients,
    log_transport_event,
    open_chat_shell_stream,
)
from .emitters import ResultEmitter
from .response_parser import ResponsesAPIEventParser
from .router import ExecutionTarget

if TYPE_CHECKING:
    import httpx
    from openai import AsyncOpenAI

logger = logging.getLogger(__name__)
_SSE_CANCEL_POLL_INTERVAL_SECONDS = 1.0
_SSE_TERMINAL_DRAIN_TIMEOUT_SECONDS = 1.0


async def _drain_terminal_stream(stream: Any, **context: Any) -> None:
    """Finish HTTP framing for keep-alive without changing a delivered terminal state."""

    async def consume_tail() -> None:
        async for _event in stream:
            pass

    try:
        await asyncio.wait_for(
            consume_tail(), timeout=_SSE_TERMINAL_DRAIN_TIMEOUT_SECONDS
        )
    except (Exception, asyncio.CancelledError) as error:
        # The terminal event has already been persisted and delivered. Closing
        # an unfinished response must not emit another terminal event.
        log_transport_event(
            "stream_cleanup_interrupted",
            **context,
            level=logging.WARNING,
            error=error,
        )


def resolve_request_id(
    request: ExecutionRequest,
    metadata: dict[str, Any],
) -> tuple[str, str]:
    """Resolve request_id for backend -> chat_shell correlation.

    Priority:
    1. Existing metadata.request_id (already propagated)
    2. request.request_id
    3. Generated fallback: req_{subtask_id}

    Returns:
        tuple: (request_id, source)
    """
    metadata_request_id = str(metadata.get("request_id", "")).strip()
    if metadata_request_id:
        return metadata_request_id, "metadata"

    request_request_id = str(getattr(request, "request_id", "")).strip()
    if request_request_id:
        return request_request_id, "request"

    return f"req_{request.subtask_id}", "generated"


async def _wait_for_sse_cancellation(
    session_manager: Any,
    subtask_id: int,
    cancel_event: asyncio.Event,
) -> str:
    """Wait for local or cross-worker cancellation independently of SSE."""

    async def poll_redis() -> str:
        while True:
            if await session_manager.is_cancelled(subtask_id):
                return "redis"
            await asyncio.sleep(_SSE_CANCEL_POLL_INTERVAL_SECONDS)

    local_cancel_task = asyncio.create_task(cancel_event.wait())
    redis_cancel_task = asyncio.create_task(poll_redis())
    try:
        done, _ = await asyncio.wait(
            {local_cancel_task, redis_cancel_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if local_cancel_task in done:
            return "local"
        return await redis_cancel_task
    finally:
        for task in (local_cancel_task, redis_cancel_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(
            local_cancel_task,
            redis_cancel_task,
            return_exceptions=True,
        )


async def _next_sse_event(
    iterator: Any, cancel_task: asyncio.Task[str]
) -> Optional[Any]:
    """Race only the upstream read against cancellation, never event persistence."""
    if cancel_task.done():
        return None
    read_task = asyncio.create_task(iterator.__anext__())
    try:
        done, _ = await asyncio.wait(
            {read_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if cancel_task in done:
            return None
        return read_task.result()
    except StopAsyncIteration:
        return None
    finally:
        if not read_task.done():
            read_task.cancel()
        await asyncio.gather(read_task, return_exceptions=True)


async def _cancel_sse_stream_open(
    stream_open_task: asyncio.Task[Any],
) -> None:
    """Cancel stream creation and close a stream returned during the race."""
    stream_open_task.cancel()
    opened = (await asyncio.gather(stream_open_task, return_exceptions=True))[0]
    if isinstance(opened, BaseException):
        return
    try:
        await opened.close()
    except Exception as exc:
        logger.warning(
            "[ExecutionDispatcher] Failed to close SSE stream opened "
            "during cancellation: error=%s",
            exc,
        )


async def dispatch_sse(
    request: ExecutionRequest,
    target: ExecutionTarget,
    emitter: ResultEmitter,
    event_parser: ResponsesAPIEventParser,
    start_event_data: dict[str, str],
) -> None:
    """Dispatch images directly or consume Chat Shell on an owned SDK connection."""
    if (request.model_config or {}).get("modelType", "llm") == "image":
        await dispatch_image_generation(request, emitter)
        return

    if not target.url:
        raise ValueError("Chat Shell SSE dispatch requires a target URL")

    openai_request = OpenAIRequestConverter.from_execution_request(request)
    metadata = openai_request.get("metadata", {})
    request_id, request_id_source = resolve_request_id(request, metadata)
    metadata["request_id"] = request_id
    openai_request["metadata"] = metadata

    with request_context(request_id):
        async with chat_shell_clients.client(target.url) as client:
            await _dispatch_chat_shell_sse(
                request,
                target,
                emitter,
                openai_request,
                request_id_source,
                event_parser,
                start_event_data,
                client,
            )


async def _dispatch_chat_shell_sse(
    request: ExecutionRequest,
    target: ExecutionTarget,
    emitter: ResultEmitter,
    openai_request: dict[str, Any],
    request_id_source: str,
    event_parser: ResponsesAPIEventParser,
    start_event_data: dict[str, str],
    client: AsyncOpenAI,
) -> None:
    """Stream a Chat Shell response within the caller's scoped request context."""
    from app.services.chat.storage.session import session_manager
    from shared.telemetry.context.propagation import (
        get_trace_context_for_propagation,
    )

    request_id = openai_request["metadata"]["request_id"]

    # OpenAI client appends /responses to base_url, so we need to include /v1
    # e.g., base_url=http://127.0.0.1:8100/v1 -> POST http://127.0.0.1:8100/v1/responses
    base_url = str(client.base_url).rstrip("/")

    # Register stream for cancellation tracking
    cancel_event = await session_manager.register_stream(request.subtask_id)

    # Get tools from openai_request (includes MCP servers converted to tools)
    tools = openai_request.get("tools", [])

    logger.info(
        f"[ExecutionDispatcher] Sending OpenAI request: model={openai_request.get('model')}, "
        f"task_id={request.task_id}, subtask_id={request.subtask_id}, "
        f"tools_count={len(tools)}, request_id={request_id}, request_id_source={request_id_source}"
    )

    # Stream response using OpenAI client
    # Note: tools is a first-class parameter in OpenAI Responses API, not in extra_body
    logger.info(
        f"[ExecutionDispatcher] About to call client.responses.create: "
        f"task_id={request.task_id}, subtask_id={request.subtask_id}"
    )
    add_span_event(
        "sse.openai_request_start",
        {
            "model": openai_request.get("model"),
            "tools_count": len(tools),
            "request_id": request_id,
        },
    )
    started = time.monotonic()
    stream_entered = False
    event_count = 0
    emit_total_ms = 0.0
    emit_max_ms = 0.0
    cancelled = False
    cancel_source = ""
    terminal_event_type = ""
    stream_open_task: Optional[asyncio.Task[Any]] = None
    cancel_task = asyncio.create_task(
        _wait_for_sse_cancellation(
            session_manager,
            request.subtask_id,
            cancel_event,
        )
    )

    try:
        # Send START event
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data=start_event_data,
        )

        stream_open_task = asyncio.create_task(
            open_chat_shell_stream(
                client,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                request_id=request_id,
                model=openai_request.get("model", ""),
                input=openai_request.get("input", ""),
                instructions=openai_request.get("instructions"),
                tools=tools if tools else None,
                stream=True,
                extra_headers={
                    **get_trace_context_for_propagation(),
                    "X-Request-ID": request_id,
                },
                extra_body={
                    "metadata": openai_request.get("metadata", {}),
                    "model_config": openai_request.get("model_config", {}),
                },
            )
        )
        done, _ = await asyncio.wait(
            {stream_open_task, cancel_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        if stream_open_task not in done:
            cancel_source = await cancel_task
            cancelled = True
            logger.info(
                "[ExecutionDispatcher] Cancellation detected while opening "
                "SSE stream: task_id=%d, subtask_id=%d, source=%s",
                request.task_id,
                request.subtask_id,
                cancel_source,
            )
            await _cancel_sse_stream_open(stream_open_task)
            stream_open_task = None
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.CANCELLED,
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    message_id=request.message_id,
                )
            )
        else:
            stream_context = await stream_open_task
            # Keep the response in an async context so cancellation closes
            # the underlying httpx response immediately.
            async with stream_context as stream:
                stream_entered = True
                logger.info(
                    "[ExecutionDispatcher] Stream created, starting to iterate "
                    "events: task_id=%d, subtask_id=%d",
                    request.task_id,
                    request.subtask_id,
                )
                add_span_event(
                    "sse.openai_stream_created",
                    {
                        "task_id": str(request.task_id),
                        "subtask_id": str(request.subtask_id),
                        "request_id": request_id,
                    },
                )

                add_span_event(
                    "sse.openai_event_iteration_start",
                    {
                        "task_id": str(request.task_id),
                        "subtask_id": str(request.subtask_id),
                    },
                )
                iterator = stream.__aiter__()
                while True:
                    event = await _next_sse_event(iterator, cancel_task)
                    if event is None:
                        break
                    event_count += 1
                    event_type = getattr(event, "type", None)
                    if not event_type:
                        continue

                    if event_count <= 5 or event_type in (
                        "response.completed",
                        "error",
                    ):
                        logger.info(
                            "[ExecutionDispatcher] SSE event #%d: type=%s, "
                            "task_id=%d, subtask_id=%d",
                            event_count,
                            event_type,
                            request.task_id,
                            request.subtask_id,
                        )
                        add_span_event(
                            "sse.openai_event_received",
                            {
                                "event_type": event_type,
                                "event_number": event_count,
                                "task_id": str(request.task_id),
                                "subtask_id": str(request.subtask_id),
                            },
                        )

                    event_data = (
                        event.model_dump()
                        if hasattr(event, "model_dump")
                        else vars(event)
                    )
                    parsed_event = event_parser.parse(
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        message_id=request.message_id,
                        event_type=event_type,
                        data=event_data,
                    )

                    if parsed_event:
                        log_fn = (
                            logger.debug
                            if parsed_event.type == EventType.TOOL_ARGUMENT_DELTA.value
                            else logger.info
                        )
                        log_fn(
                            "[ExecutionDispatcher] Parsed SSE event -> "
                            "internal event: task_id=%d, subtask_id=%d, "
                            "request_id=%s, sse_event=%s, internal_event=%s",
                            request.task_id,
                            request.subtask_id,
                            request_id,
                            event_type,
                            parsed_event.type,
                        )
                        emit_started = time.perf_counter()
                        try:
                            await emitter.emit(parsed_event)
                        finally:
                            emit_ms = (time.perf_counter() - emit_started) * 1000
                            emit_total_ms += emit_ms
                            emit_max_ms = max(emit_max_ms, emit_ms)

                    if event_type in (
                        ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
                        ResponsesAPIStreamEvents.ERROR.value,
                        ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
                    ):
                        terminal_event_type = event_type
                        logger.info(
                            "[ExecutionDispatcher] Terminal event received, "
                            "breaking stream loop: task_id=%d, subtask_id=%d, "
                            "event_type=%s, request_id=%s",
                            request.task_id,
                            request.subtask_id,
                            event_type,
                            request_id,
                        )
                        add_span_event(
                            "sse.openai_terminal_event",
                            {
                                "event_type": event_type,
                                "total_events": event_count,
                                "task_id": str(request.task_id),
                                "subtask_id": str(request.subtask_id),
                            },
                        )
                        break

                if not terminal_event_type and cancel_task.done():
                    cancel_source = await cancel_task
                    cancelled = True
                    logger.info(
                        "[ExecutionDispatcher] Cancellation detected while "
                        "reading SSE stream: task_id=%d, subtask_id=%d, source=%s",
                        request.task_id,
                        request.subtask_id,
                        cancel_source,
                    )
                elif terminal_event_type:
                    await _drain_terminal_stream(
                        stream,
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        request_id=request_id,
                        target_url=f"{base_url}/responses",
                    )

                if cancelled:
                    await emitter.emit(
                        ExecutionEvent(
                            type=EventType.CANCELLED,
                            task_id=request.task_id,
                            subtask_id=request.subtask_id,
                            message_id=request.message_id,
                        )
                    )

                if not cancelled and not terminal_event_type:
                    error_message = (
                        "Chat Shell SSE stream ended without terminal event "
                        f"after {event_count} events"
                    )
                    logger.warning(
                        "[ExecutionDispatcher] SSE stream ended without "
                        "terminal event: task_id=%d, subtask_id=%d, "
                        "request_id=%s, total_events=%d",
                        request.task_id,
                        request.subtask_id,
                        request_id,
                        event_count,
                    )
                    add_span_event(
                        "sse.openai_stream_no_terminal",
                        {
                            "warning": True,
                            "total_events": event_count,
                            "task_id": str(request.task_id),
                            "subtask_id": str(request.subtask_id),
                        },
                    )
                    await emitter.emit(
                        ExecutionEvent(
                            type=EventType.ERROR,
                            task_id=request.task_id,
                            subtask_id=request.subtask_id,
                            message_id=request.message_id,
                            error=error_message,
                            error_code="sse_stream_no_terminal",
                        )
                    )

        logger.info(
            "[ExecutionDispatcher] SSE stream completed: task_id=%d, "
            "subtask_id=%d, total_events=%d, cancelled=%s, "
            "cancel_source=%s, terminal_event_type=%s, request_id=%s, "
            "emit_total_ms=%.2f, emit_max_ms=%.2f",
            request.task_id,
            request.subtask_id,
            event_count,
            cancelled,
            cancel_source or "none",
            terminal_event_type or "none",
            request_id,
            emit_total_ms,
            emit_max_ms,
        )
        add_span_event(
            "sse.openai_event_iteration_complete",
            {
                "total_events": event_count,
                "cancelled": cancelled,
                "cancel_source": cancel_source or "none",
                "terminal_event_type": terminal_event_type or "none",
                "task_id": str(request.task_id),
                "subtask_id": str(request.subtask_id),
            },
        )
    except Exception as error:
        log_transport_event(
            "dispatch_failed",
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            request_id=request_id,
            target_url=f"{base_url}/responses",
            level=logging.ERROR,
            error=error,
            stage="stream" if stream_entered else "open_stream",
            events_received=event_count,
            elapsed_ms=(time.monotonic() - started) * 1000,
        )
        raise
    finally:
        if stream_open_task is not None and not stream_entered:
            await _cancel_sse_stream_open(stream_open_task)
        if not cancel_task.done():
            cancel_task.cancel()
        await asyncio.gather(cancel_task, return_exceptions=True)

        await session_manager.unregister_stream(request.subtask_id)
        add_span_event(
            "sse.stream_unregistered",
            {
                "task_id": str(request.task_id),
                "subtask_id": str(request.subtask_id),
            },
        )


async def dispatch_image_generation(
    request: ExecutionRequest,
    emitter: ResultEmitter,
) -> None:
    """Dispatch image generation task to ImageAgent.

    ImageAgent handles:
    1. Calling Seedream API directly
    2. Uploading result as attachment
    3. Emitting events via emitter

    Args:
        request: Execution request
        emitter: Result emitter for event emission
    """
    from .agents.image.image_agent import ImageAgent

    logger.info(
        f"[ExecutionDispatcher] Dispatching to ImageAgent: "
        f"task_id={request.task_id}, subtask_id={request.subtask_id}"
    )

    agent = ImageAgent()
    await agent.execute(request, emitter)


async def cancel_chat_shell(subtask_id: int) -> bool:
    """Set distributed cancellation independently of the SSE connection."""
    from app.services.chat.storage.session import session_manager

    try:
        success = await session_manager.cancel_stream(subtask_id)
        if success:
            logger.info(
                f"[ExecutionDispatcher] SSE cancel flag set via Redis: "
                f"subtask_id={subtask_id}"
            )
        return success
    except Exception as e:
        logger.error(
            f"[ExecutionDispatcher] Failed to set SSE cancel flag: "
            f"subtask_id={subtask_id}, error={e}"
        )
        return False


async def notify_chat_shell_error(
    request: ExecutionRequest,
    target: ExecutionTarget,
    error_message: str,
    http_client: httpx.AsyncClient,
) -> None:
    """Send error to SSE service.

    For SSE mode, we notify the chat_shell service about the error
    so it can clean up any pending state.

    Args:
        request: Execution request
        target: Execution target configuration
        error_message: Error message
    """
    url = f"{target.url}/v1/responses/error"
    try:
        request_id, _ = resolve_request_id(
            request, {"request_id": getattr(request, "request_id", "")}
        )
        await http_client.post(
            url,
            json={
                "request_id": request_id,
                "error": error_message,
            },
        )
    except Exception as e:
        # Error notification to chat_shell is best-effort
        logger.warning(
            f"[ExecutionDispatcher] Failed to notify SSE service about error: {e}"
        )
