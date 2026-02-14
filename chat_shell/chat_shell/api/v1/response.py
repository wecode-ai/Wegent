"""
/v1/responses API endpoint implementation.

This is the main API endpoint for chat_shell.
Uses ChatService for actual chat processing.
Output format is compatible with OpenAI Responses API for standard client consumption.

Architecture:
- API layer creates SSETransport and emitter
- Passes emitter to ChatService
- ChatService streams events directly via emitter
- SSETransport yields ServerSentEvent objects for SSE streaming
"""

import asyncio
import json
import logging
import time
import uuid
from typing import AsyncGenerator, Optional, Union

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from shared.models import ExecutionRequest, OpenAIRequestConverter, ResponsesAPIEmitter
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.models.responses_api_emitter import EventTransport

router = APIRouter(prefix="/v1", tags=["responses"])
logger = logging.getLogger(__name__)

_start_time = time.time()


# ============================================================
# SSE Transport - Streams events directly to SSE
# ============================================================


class SSETransport(EventTransport):
    """SSE Transport that yields ServerSentEvent objects.

    This transport collects events in an async queue, allowing the API layer
    to yield them as SSE events in real-time.
    """

    def __init__(self):
        """Initialize SSE transport with an async queue."""
        self._queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()
        self._done = False

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> tuple[str, dict]:
        """Send event to the queue for SSE streaming."""
        await self._queue.put((event_type, data))
        return (event_type, data)

    async def get_event(self) -> Optional[tuple[str, dict]]:
        """Get next event from queue. Returns None when done."""
        if self._done and self._queue.empty():
            return None
        try:
            return await asyncio.wait_for(self._queue.get(), timeout=0.1)
        except asyncio.TimeoutError:
            return None

    def mark_done(self):
        """Mark the transport as done (no more events will be sent)."""
        self._done = True

    def is_done(self) -> bool:
        """Check if transport is done and queue is empty."""
        return self._done and self._queue.empty()


# ============================================================
# OpenAI Responses API Request Schema
# ============================================================


class OpenAIResponsesRequest(BaseModel):
    """OpenAI Responses API compatible request schema."""

    model: str = Field(..., description="Model identifier")
    input: Union[str, list[dict]] = Field(..., description="User input")
    instructions: Optional[str] = Field(None, description="System instructions")
    stream: bool = Field(True, description="Whether to stream response")
    tools: Optional[list[dict]] = Field(None, description="Tools including MCP servers")

    # Custom extensions for internal use (passed via extra_body)
    metadata: Optional[dict] = Field(None, description="Internal metadata")
    model_config_data: Optional[dict] = Field(
        None, alias="model_config", description="Model configuration"
    )

    class Config:
        populate_by_name = True
        extra = "allow"


class CancelRequest(BaseModel):
    """Cancel request schema."""

    subtask_id: int = Field(..., description="Subtask ID to cancel")


class CancelResponse(BaseModel):
    """Cancel response schema."""

    success: bool = Field(..., description="Whether cancel was successful")
    message: str = Field(..., description="Status message")


class StorageHealth(BaseModel):
    """Storage health info."""

    type: str = Field(..., description="Storage type")
    status: str = Field(..., description="Storage status")


class HealthResponse(BaseModel):
    """Health check response schema."""

    status: str = Field(..., description="Overall status")
    version: str = Field(..., description="chat_shell version")
    uptime_seconds: int = Field(..., description="Service uptime in seconds")
    active_streams: int = Field(0, description="Active stream count")
    storage: Optional[StorageHealth] = Field(None, description="Storage health")
    model_providers: Optional[dict[str, str]] = Field(
        None, description="Model provider status"
    )


# ============================================================
# Helper Functions
# ============================================================


def _create_sse_event(event_type: str, data: dict) -> ServerSentEvent:
    """Create SSE event in OpenAI Responses API format."""
    return ServerSentEvent(
        event=event_type,
        data=json.dumps(data, ensure_ascii=False),
    )


def _extract_stream_attributes(
    request: OpenAIResponsesRequest,
    request_id: str,
) -> dict:
    """Extract attributes from stream request for tracing."""
    attrs = {"request.id": request_id}
    if request.metadata:
        if request.metadata.get("task_id"):
            attrs["task.id"] = request.metadata["task_id"]
        if request.metadata.get("subtask_id"):
            attrs["subtask.id"] = request.metadata["subtask_id"]
        if request.metadata.get("user_id"):
            attrs["user.id"] = str(request.metadata["user_id"])
    attrs["model.id"] = request.model or ""
    return attrs


# ============================================================
# Stream Response Generator
# ============================================================

from shared.telemetry.decorators import trace_async_generator


@trace_async_generator(
    span_name="chat_shell.stream_response",
    tracer_name="chat_shell",
    extract_attributes=_extract_stream_attributes,
)
async def _stream_response(
    request: OpenAIResponsesRequest,
    request_id: str,
) -> AsyncGenerator[ServerSentEvent, None]:
    """
    Stream response generator using ChatService.

    Creates SSETransport and emitter, passes to ChatService.
    ChatService streams events directly via emitter.
    This generator yields events from the transport queue.

    Cancellation is handled via session_manager which is used by StreamingCore.
    """
    from chat_shell.core.shutdown import shutdown_manager
    from chat_shell.services.chat_service import chat_service
    from chat_shell.services.storage.session import session_manager

    # Register stream with shutdown manager
    await shutdown_manager.register_stream(request_id)

    # Extract metadata
    metadata = request.metadata or {}
    task_id = metadata.get("task_id", 0)
    subtask_id = metadata.get("subtask_id", 0)

    # Create SSE transport and emitter
    transport = SSETransport()
    emitter = ResponsesAPIEmitter(
        task_id=task_id,
        subtask_id=subtask_id,
        transport=transport,
        model=request.model,
    )

    # Convert OpenAI format to ExecutionRequest
    openai_dict = {
        "model": request.model,
        "input": request.input,
        "instructions": request.instructions,
        "tools": request.tools or [],
        "metadata": request.metadata or {},
        "model_config": request.model_config_data or {},
    }
    execution_request = OpenAIRequestConverter.to_execution_request(openai_dict)

    logger.info(
        "[RESPONSE] Processing request: task_id=%d, subtask_id=%d, model=%s",
        task_id,
        subtask_id,
        request.model,
    )

    # Record request details to trace
    from shared.telemetry.context import SpanAttributes, set_span_attributes

    set_span_attributes(
        {
            SpanAttributes.TASK_ID: task_id,
            SpanAttributes.SUBTASK_ID: subtask_id,
            SpanAttributes.MCP_SERVERS_COUNT: len(execution_request.mcp_servers),
            SpanAttributes.SKILL_NAMES: (
                ",".join(execution_request.skill_names)
                if execution_request.skill_names
                else ""
            ),
            SpanAttributes.SKILL_COUNT: len(execution_request.skill_configs),
            SpanAttributes.KB_IDS: (
                ",".join(map(str, execution_request.knowledge_base_ids))
                if execution_request.knowledge_base_ids
                else ""
            ),
            SpanAttributes.CHAT_WEB_SEARCH: execution_request.enable_web_search,
            SpanAttributes.CHAT_DEEP_THINKING: execution_request.enable_deep_thinking,
            SpanAttributes.CHAT_TYPE: (
                "group" if execution_request.is_group_chat else "single"
            ),
        }
    )

    # Start chat processing in background task
    # Note: chat_service.chat() uses StreamingCore which registers with session_manager
    # for cancellation support. The cancel_event is managed by session_manager.
    chat_task = asyncio.create_task(chat_service.chat(execution_request, emitter))

    try:
        # Yield events from transport queue as they arrive
        while not transport.is_done() or not chat_task.done():
            # Check for cancellation via session_manager
            if session_manager.is_cancelled(subtask_id):
                chat_task.cancel()
                event_type, data = await emitter.incomplete("cancelled")
                yield _create_sse_event(event_type, data)
                return

            # Get next event from queue
            event = await transport.get_event()
            if event:
                event_type, data = event
                yield _create_sse_event(event_type, data)

                # Mark transport as done on terminal events to exit loop
                # This ensures the SSE stream closes properly after completion
                if event_type in (
                    ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
                    ResponsesAPIStreamEvents.ERROR.value,
                    ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
                ):
                    logger.info(
                        "[RESPONSE] Terminal event sent, marking transport done: "
                        "task_id=%d, subtask_id=%d, event_type=%s",
                        task_id,
                        subtask_id,
                        event_type,
                    )
                    transport.mark_done()

            # Check if chat task completed with error
            if chat_task.done() and chat_task.exception():
                raise chat_task.exception()

        # Drain remaining events
        while True:
            event = await transport.get_event()
            if event is None:
                break
            event_type, data = event
            yield _create_sse_event(event_type, data)

        # Wait for chat task to complete
        await chat_task

    except asyncio.CancelledError:
        chat_task.cancel()
        event_type, data = await emitter.incomplete("cancelled")
        yield _create_sse_event(event_type, data)

    except Exception as e:
        import traceback

        logger.error("[RESPONSE] Error: %s\n%s", e, traceback.format_exc())
        event_type, data = await emitter.error(str(e))
        yield _create_sse_event(event_type, data)

    finally:
        transport.mark_done()
        await shutdown_manager.unregister_stream(request_id)


# ============================================================
# API Endpoints
# ============================================================


@router.post("/responses")
async def create_response(request: OpenAIResponsesRequest, req: Request):
    """
    Create a streaming response.

    This endpoint is compatible with OpenAI Responses API.
    """
    from shared.telemetry.context import set_request_context

    request_id = req.headers.get("X-Request-ID")
    if not request_id:
        metadata = request.metadata or {}
        request_id = metadata.get("request_id") or f"req_{uuid.uuid4().hex[:24]}"

    set_request_context(request_id)

    return EventSourceResponse(
        _stream_response(request, request_id),
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Request-ID": request_id,
        },
    )


@router.post("/responses/cancel")
async def cancel_response(request: CancelRequest):
    """Cancel an ongoing response by subtask_id."""
    from chat_shell.services.chat_service import chat_service

    subtask_id = request.subtask_id

    success = await chat_service.cancel(subtask_id)
    if success:
        logger.info("[RESPONSE] Cancelled stream for subtask_id=%d", subtask_id)
        return CancelResponse(success=True, message="Request cancelled")

    # Stream not found - might have already completed
    logger.warning(
        "[RESPONSE] Cancel failed - stream not found for subtask_id=%d", subtask_id
    )
    raise HTTPException(
        status_code=404, detail="Request not found or already completed"
    )


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    from chat_shell import __version__ as version
    from chat_shell.services.storage.session import session_manager

    uptime = int(time.time() - _start_time)

    return HealthResponse(
        status="healthy",
        version=version,
        uptime_seconds=uptime,
        active_streams=session_manager.get_active_stream_count(),
        storage=StorageHealth(type="memory", status="ok"),
        model_providers=None,
    )
