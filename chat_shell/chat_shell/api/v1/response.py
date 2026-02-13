"""
/v1/responses API endpoint implementation.

This is the main API endpoint for chat_shell.
Uses ChatService for actual chat processing.
Output format is compatible with OpenAI Responses API for standard client consumption.

Input format: OpenAI Responses API standard format
- model: Model identifier
- input: User message (string or messages array)
- instructions: System prompt
- stream: Whether to stream (always true for this endpoint)
- metadata: Custom metadata for internal use
- model_config: Model configuration for internal use
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

from shared.models import ExecutionRequest, OpenAIRequestConverter
from shared.models.emitter import GeneratorTransport, ResponsesAPIEmitter
from shared.models.execution import EventType
from shared.models.responses_api import ResponsesAPIStreamEvents

router = APIRouter(prefix="/v1", tags=["responses"])
logger = logging.getLogger(__name__)

# Track active streams for cancellation and health check
_active_streams: dict[str, asyncio.Event] = {}
_start_time = time.time()


# ============================================================
# OpenAI Responses API Request Schema
# ============================================================


class OpenAIResponsesRequest(BaseModel):
    """OpenAI Responses API compatible request schema.

    This is the standard format that OpenAI client sends.
    """

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
        extra = "allow"  # Allow extra fields from OpenAI client


class CancelRequest(BaseModel):
    """Cancel request schema."""

    request_id: str = Field(..., description="Request ID to cancel")


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
    """Create SSE event in OpenAI Responses API format.

    Args:
        event_type: Event type string (e.g., "response.created")
        data: Event data dictionary

    Returns:
        ServerSentEvent object
    """
    return ServerSentEvent(
        event=event_type,
        data=json.dumps(data, ensure_ascii=False),
    )


def _extract_stream_attributes(
    request: OpenAIResponsesRequest,
    cancel_event: asyncio.Event,
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
    cancel_event: asyncio.Event,
    request_id: str,
) -> AsyncGenerator[ServerSentEvent, None]:
    """
    Stream response generator using ChatService.

    Converts OpenAI format request to ExecutionRequest and uses ChatService for processing.
    Output format is compatible with OpenAI Responses API.
    Uses ResponsesAPIEmitter with GeneratorTransport for unified event generation.
    """
    from chat_shell.core.shutdown import shutdown_manager
    from chat_shell.services.chat_service import chat_service

    # Register stream with shutdown manager
    await shutdown_manager.register_stream(request_id)

    # Extract metadata
    metadata = request.metadata or {}
    task_id = metadata.get("task_id", 0)
    subtask_id = metadata.get("subtask_id", 0)

    # Create emitter with GeneratorTransport
    transport = GeneratorTransport()
    emitter = ResponsesAPIEmitter(
        task_id=task_id,
        subtask_id=subtask_id,
        transport=transport,
        model=request.model,
    )

    full_content = ""
    total_input_tokens = 0
    total_output_tokens = 0
    emitted_tool_run_ids: set[str] = set()
    accumulated_sources: list[dict] = []
    is_silent_exit = False
    silent_exit_reason = ""
    done_extra_fields: dict = {}

    try:
        # Send response.created event
        event_type, data = await emitter.start()
        yield _create_sse_event(event_type, data)

        # Send response.in_progress event
        event_type, data = await emitter.in_progress()
        yield _create_sse_event(event_type, data)

        # Send output_item.added event for the message
        event_type, data = await transport.send(
            event_type=ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            task_id=task_id,
            subtask_id=subtask_id,
            data=emitter.builder.output_item_added(),
        )
        yield _create_sse_event(event_type, data)

        # Send content_part.added event
        event_type, data = await transport.send(
            event_type=ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
            task_id=task_id,
            subtask_id=subtask_id,
            data=emitter.builder.content_part_added(),
        )
        yield _create_sse_event(event_type, data)

        # Convert OpenAI format to ExecutionRequest using shared converter
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

        # Stream from ChatService
        async for event in chat_service.chat(execution_request):

            # Check for cancellation
            if cancel_event.is_set():
                event_type, data = await emitter.incomplete("cancelled", full_content)
                yield _create_sse_event(event_type, data)
                return

            # Process ExecutionEvent
            event_type_str = event.type
            if event_type_str == EventType.CHUNK.value:
                chunk_text = event.content or event.data.get("content", "")
                result = event.result or event.data.get("result")

                # Send output_text.delta event
                if chunk_text:
                    full_content += chunk_text
                    event_type, data = await emitter.text_delta(chunk_text)
                    yield _create_sse_event(event_type, data)

                # Accumulate sources
                if result and result.get("sources"):
                    for source in result["sources"]:
                        key = (source.get("kb_id"), source.get("title"))
                        existing_keys = {
                            (s.get("kb_id"), s.get("title"))
                            for s in accumulated_sources
                        }
                        if key not in existing_keys:
                            accumulated_sources.append(source)

                # Process tool_event directly from event.data (new format)
                tool_event = event.data.get("tool_event") if event.data else None
                if tool_event:
                    tool_type = tool_event.get("type")
                    tool_use_id = tool_event.get("tool_use_id", "")
                    tool_name = tool_event.get("tool_name", "")
                    status = tool_event.get("status", "")

                    event_key = f"{tool_use_id}:{status}"
                    if event_key not in emitted_tool_run_ids:
                        emitted_tool_run_ids.add(event_key)

                        if tool_type == "tool_use" and status == "started":
                            # Get display_name from tool_event (Wegent extension)
                            display_name = tool_event.get("display_name")
                            tool_input = tool_event.get("input", {})

                            # Send tool start events
                            # tool_start internally emits two events to transport
                            await emitter.tool_start(
                                tool_use_id, tool_name, tool_input, display_name
                            )
                            # Get all events from transport and yield them
                            for evt_type, evt_data in transport.get_events():
                                yield _create_sse_event(evt_type, evt_data)

                        elif tool_type == "tool_result" and status in (
                            "completed",
                            "failed",
                        ):
                            tool_input = tool_event.get("input", {})

                            # Send tool done events
                            # tool_done internally emits two events to transport
                            await emitter.tool_done(tool_use_id, tool_name, tool_input)
                            # Get all events from transport and yield them
                            for evt_type, evt_data in transport.get_events():
                                yield _create_sse_event(evt_type, evt_data)

            elif event_type_str == EventType.TOOL_START.value:
                tool_use_id = event.tool_use_id or event.data.get("tool_call_id", "")
                tool_name = event.tool_name or event.data.get("tool_name", "")
                tool_input = event.tool_input or event.data.get("tool_input", {})
                # Get display_name from event data (Wegent extension)
                display_name = event.data.get("display_name") if event.data else None

                # Send tool start events
                # tool_start internally emits two events to transport
                await emitter.tool_start(
                    tool_use_id, tool_name, tool_input, display_name
                )
                # Get all events from transport and yield them
                for evt_type, evt_data in transport.get_events():
                    yield _create_sse_event(evt_type, evt_data)

            elif event_type_str == EventType.TOOL_RESULT.value:
                tool_use_id = event.tool_use_id or event.data.get("tool_call_id", "")

                # Send tool done events
                # tool_done internally emits two events to transport
                await emitter.tool_done(tool_use_id, "", None)
                # Get all events from transport and yield them
                for evt_type, evt_data in transport.get_events():
                    yield _create_sse_event(evt_type, evt_data)

            elif event_type_str == EventType.DONE.value:
                result = event.result or event.data.get("result", {})
                usage = result.get("usage") if result else None
                if usage:
                    total_input_tokens = usage.get("input_tokens", 0)
                    total_output_tokens = usage.get("output_tokens", 0)
                if result and result.get("silent_exit"):
                    is_silent_exit = True
                    silent_exit_reason = result.get("silent_exit_reason", "")
                # Collect extra fields (exclude blocks as it's no longer used)
                known_fields = {
                    "usage",
                    "silent_exit",
                    "silent_exit_reason",
                    "sources",
                    "shell_type",
                    "value",
                    "thinking",
                }
                if result:
                    for key, value in result.items():
                        if key not in known_fields and value is not None:
                            done_extra_fields[key] = value

            elif event_type_str == EventType.ERROR.value:
                error_msg = event.error or event.data.get("error", "Unknown error")
                event_type, data = await emitter.error(error_msg)
                yield _create_sse_event(event_type, data)
                return

            elif event_type_str == EventType.CANCELLED.value:
                event_type, data = await emitter.incomplete("cancelled")
                yield _create_sse_event(event_type, data)
                return

        # Send output_text.done event
        event_type, data = await transport.send(
            event_type=ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
            task_id=task_id,
            subtask_id=subtask_id,
            data=emitter.builder.text_done(full_content),
        )
        yield _create_sse_event(event_type, data)

        # Build annotations from sources
        annotations = []
        if accumulated_sources:
            annotations = [
                {
                    "type": "url_citation",
                    "start_index": 0,
                    "end_index": 0,
                    "url": s.get("url", ""),
                    "title": s.get("title", ""),
                }
                for s in accumulated_sources
                if s.get("url")
            ]

        # Send content_part.done event
        event_type, data = await transport.send(
            event_type=ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
            task_id=task_id,
            subtask_id=subtask_id,
            data=emitter.builder.content_part_done(full_content, annotations),
        )
        yield _create_sse_event(event_type, data)

        # Send output_item.done event
        event_type, data = await transport.send(
            event_type=ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            task_id=task_id,
            subtask_id=subtask_id,
            data=emitter.builder.output_item_done(full_content),
        )
        yield _create_sse_event(event_type, data)

        # Build sources for response
        formatted_sources = None
        if accumulated_sources:
            formatted_sources = [
                {
                    "index": source.get("index"),
                    "title": source.get("title", "Unknown"),
                    "kb_id": source.get("kb_id"),
                    "url": source.get("url"),
                    "snippet": source.get("snippet"),
                }
                for source in accumulated_sources
            ]

        # Build usage dict
        usage_dict = None
        if total_input_tokens or total_output_tokens:
            usage_dict = {
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens,
                "total_tokens": total_input_tokens + total_output_tokens,
            }

        # Send response.completed event
        event_type, data = await emitter.done(
            content=full_content,
            usage=usage_dict,
            stop_reason="silent_exit" if is_silent_exit else "end_turn",
            sources=formatted_sources,
            silent_exit=is_silent_exit if is_silent_exit else None,
            silent_exit_reason=silent_exit_reason if silent_exit_reason else None,
            **done_extra_fields,
        )

        logger.info(
            "[RESPONSE] Sending response.completed: subtask_id=%d, "
            "loaded_skills=%s, extra_fields=%s",
            subtask_id,
            data.get("response", {}).get("loaded_skills"),
            list(done_extra_fields.keys()),
        )

        yield _create_sse_event(event_type, data)

    except asyncio.CancelledError:
        event_type, data = await emitter.incomplete("cancelled")
        yield _create_sse_event(event_type, data)

    except Exception as e:
        import traceback

        logger.error("[RESPONSE] Error: %s\n%s", e, traceback.format_exc())
        event_type, data = await emitter.error(str(e))
        yield _create_sse_event(event_type, data)

    finally:
        await shutdown_manager.unregister_stream(request_id)
        cleanup_stream(request_id)


# ============================================================
# API Endpoints
# ============================================================


@router.post("/responses")
async def create_response(request: OpenAIResponsesRequest, req: Request):
    """
    Create a streaming response.

    This endpoint is compatible with OpenAI Responses API.
    Can be consumed with standard OpenAI client:

    ```python
    from openai import OpenAI
    client = OpenAI(base_url="http://localhost:8100/v1", api_key="dummy")
    stream = client.responses.create(
        model="gpt-4",
        input="Hello",
        stream=True,
        extra_body={
            "metadata": {"task_id": 1, "subtask_id": 1},
            "model_config": {"api_key": "...", "base_url": "..."}
        }
    )
    for event in stream:
        print(event)
    ```
    """
    from shared.telemetry.context import set_request_context

    request_id = req.headers.get("X-Request-ID")
    if not request_id:
        metadata = request.metadata or {}
        request_id = metadata.get("request_id") or f"req_{uuid.uuid4().hex[:24]}"

    set_request_context(request_id)

    cancel_event = asyncio.Event()
    _active_streams[request_id] = cancel_event

    return EventSourceResponse(
        _stream_response(request, cancel_event, request_id),
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Request-ID": request_id,
        },
    )


@router.post("/responses/cancel")
async def cancel_response(request: CancelRequest):
    """
    Cancel an ongoing response.

    This endpoint allows cancelling a streaming response by its request ID.
    """
    request_id = request.request_id

    if request_id not in _active_streams:
        raise HTTPException(
            status_code=404, detail="Request not found or already completed"
        )

    cancel_event = _active_streams.get(request_id)
    if cancel_event:
        cancel_event.set()
        return CancelResponse(success=True, message="Request cancelled")

    return CancelResponse(success=False, message="Request not found")


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint.

    Returns service health status including storage and model provider status.
    """
    from chat_shell import __version__ as version

    uptime = int(time.time() - _start_time)

    return HealthResponse(
        status="healthy",
        version=version,
        uptime_seconds=uptime,
        active_streams=len(_active_streams),
        storage=StorageHealth(type="memory", status="ok"),
        model_providers=None,
    )


def cleanup_stream(request_id: str):
    """Clean up stream resources after completion."""
    if request_id in _active_streams:
        del _active_streams[request_id]
