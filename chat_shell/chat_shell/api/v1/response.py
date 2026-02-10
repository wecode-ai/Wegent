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
import logging
import time
import uuid
from typing import Any, AsyncGenerator, Optional, Union

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from shared.models import ExecutionRequest, OpenAIRequestConverter
from shared.models.execution import EventType
from shared.models.responses_api import (
    ResponsesAPIStreamEvents,
    create_error_event,
    create_output_text_delta_event,
    create_response_completed_event,
    create_response_created_event,
)

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
    import json

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
    """
    from chat_shell.core.shutdown import shutdown_manager
    from chat_shell.services.chat_service import chat_service

    # Register stream with shutdown manager
    await shutdown_manager.register_stream(request_id)

    response_id = f"resp_{uuid.uuid4().hex[:24]}"
    item_id = f"msg_{uuid.uuid4().hex[:24]}"
    full_content = ""
    total_input_tokens = 0
    total_output_tokens = 0
    emitted_tool_run_ids: set[str] = set()
    accumulated_sources: list[dict] = []
    accumulated_blocks: list[dict] = []
    is_silent_exit = False
    silent_exit_reason = ""
    done_extra_fields: dict = {}
    content_index = 0
    output_index = 0
    created_at = int(time.time())
    model_id = request.model

    try:
        # Send response.created event
        yield _create_sse_event(
            ResponsesAPIStreamEvents.RESPONSE_CREATED.value,
            create_response_created_event(response_id, model_id, created_at),
        )

        # Send response.in_progress event
        yield _create_sse_event(
            ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
            {
                "type": ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
                "response": {
                    "id": response_id,
                    "object": "response",
                    "created_at": created_at,
                    "model": model_id,
                    "status": "in_progress",
                    "output": [],
                },
            },
        )

        # Send output_item.added event for the message
        yield _create_sse_event(
            ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            {
                "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
                "output_index": output_index,
                "item": {
                    "type": "message",
                    "id": item_id,
                    "status": "in_progress",
                    "role": "assistant",
                    "content": [],
                },
            },
        )

        # Send content_part.added event
        yield _create_sse_event(
            ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
            {
                "type": ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
                "item_id": item_id,
                "output_index": output_index,
                "content_index": content_index,
                "part": {
                    "type": "output_text",
                    "text": "",
                    "annotations": [],
                },
            },
        )

        # Convert OpenAI format to ExecutionRequest using shared converter
        openai_dict = {
            "model": request.model,
            "input": request.input,
            "instructions": request.instructions,
            "metadata": request.metadata or {},
            "model_config": request.model_config_data or {},
        }
        execution_request = OpenAIRequestConverter.to_execution_request(openai_dict)

        # Extract metadata for logging
        metadata = request.metadata or {}
        task_id = metadata.get("task_id", 0)
        subtask_id = metadata.get("subtask_id", 0)

        logger.info(
            "[RESPONSE] Processing request: task_id=%d, subtask_id=%d, model=%s",
            task_id,
            subtask_id,
            model_id,
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
                yield _create_sse_event(
                    ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
                    {
                        "type": ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
                        "response": {
                            "id": response_id,
                            "object": "response",
                            "status": "incomplete",
                            "incomplete_details": {"reason": "cancelled"},
                            "output": [
                                {
                                    "type": "message",
                                    "id": item_id,
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "output_text",
                                            "text": full_content,
                                        }
                                    ],
                                }
                            ],
                        },
                    },
                )
                return

            # Process ExecutionEvent
            event_type = event.type
            if event_type == EventType.CHUNK.value:
                chunk_text = event.content or event.data.get("content", "")
                result = event.result or event.data.get("result")
                block_id = event.data.get("block_id")
                block_offset = event.data.get("block_offset")

                # Send output_text.delta event
                if chunk_text:
                    full_content += chunk_text
                    yield _create_sse_event(
                        ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
                        create_output_text_delta_event(
                            item_id=item_id,
                            output_index=output_index,
                            content_index=content_index,
                            delta=chunk_text,
                            result=result,
                            block_id=block_id,
                            block_offset=block_offset,
                        ),
                    )

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

                # Process thinking steps for tool events
                if result and result.get("thinking"):
                    for step in result["thinking"]:
                        details = step.get("details", {})
                        status = details.get("status")
                        tool_name = details.get("tool_name", details.get("name", ""))
                        # Use tool_use_id as the primary identifier (matches blocks)
                        # Fallback to run_id for backward compatibility
                        tool_use_id = step.get("tool_use_id") or step.get("run_id", "")
                        title = step.get("title", "")
                        blocks = result.get("blocks", [])

                        event_key = f"{tool_use_id}:{status}"
                        if event_key in emitted_tool_run_ids:
                            continue
                        emitted_tool_run_ids.add(event_key)

                        if status == "started":
                            yield _create_sse_event(
                                ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
                                {
                                    "type": ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
                                    "item_id": tool_use_id,
                                    "output_index": output_index,
                                    "call_id": tool_use_id,
                                    "delta": "",
                                    "tool_name": tool_name,
                                    "tool_input": details.get("input", {}),
                                    "display_name": title,
                                    "blocks": blocks,
                                    "status": "started",
                                },
                            )
                        elif status in ("completed", "failed"):
                            yield _create_sse_event(
                                ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
                                {
                                    "type": ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
                                    "item_id": tool_use_id,
                                    "output_index": output_index,
                                    "call_id": tool_use_id,
                                    "arguments": "",
                                    "tool_name": tool_name,
                                    "output": details.get(
                                        "output", details.get("content")
                                    ),
                                    "error": (
                                        details.get("error")
                                        if status == "failed"
                                        else None
                                    ),
                                    "display_name": (
                                        title if status == "failed" else None
                                    ),
                                    "blocks": blocks,
                                    "status": status,
                                },
                            )

            elif event_type == EventType.THINKING.value:
                thinking_text = event.content or event.data.get("content", "")
                if thinking_text:
                    yield _create_sse_event(
                        ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value,
                        {
                            "type": ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value,
                            "item_id": item_id,
                            "output_index": output_index,
                            "part": {
                                "type": "reasoning",
                                "text": thinking_text,
                            },
                        },
                    )

            elif event_type == EventType.TOOL_START.value:
                yield _create_sse_event(
                    ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
                    {
                        "type": ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
                        "item_id": event.tool_use_id
                        or event.data.get("tool_call_id", ""),
                        "output_index": output_index,
                        "call_id": event.tool_use_id
                        or event.data.get("tool_call_id", ""),
                        "delta": "",
                        "tool_name": event.tool_name or event.data.get("tool_name", ""),
                        "tool_input": event.tool_input
                        or event.data.get("tool_input", {}),
                        "blocks": event.data.get("blocks", []),
                        "status": "started",
                    },
                )

            elif event_type == EventType.TOOL_RESULT.value:
                yield _create_sse_event(
                    ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
                    {
                        "type": ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
                        "item_id": event.tool_use_id
                        or event.data.get("tool_call_id", ""),
                        "output_index": output_index,
                        "call_id": event.tool_use_id
                        or event.data.get("tool_call_id", ""),
                        "arguments": "",
                        "output": (
                            event.tool_output
                            if event.tool_output is not None
                            else event.data.get("tool_output")
                        ),
                        "blocks": event.data.get("blocks", []),
                        "status": "completed",
                    },
                )

            elif event_type == EventType.DONE.value:
                result = event.result or event.data.get("result", {})
                usage = result.get("usage") if result else None
                if usage:
                    total_input_tokens = usage.get("input_tokens", 0)
                    total_output_tokens = usage.get("output_tokens", 0)
                if result and result.get("silent_exit"):
                    is_silent_exit = True
                    silent_exit_reason = result.get("silent_exit_reason", "")
                if result and result.get("blocks"):
                    accumulated_blocks = result["blocks"]
                # Collect extra fields
                known_fields = {
                    "usage",
                    "silent_exit",
                    "silent_exit_reason",
                    "blocks",
                    "sources",
                    "shell_type",
                    "value",
                    "thinking",
                }
                if result:
                    for key, value in result.items():
                        if key not in known_fields and value is not None:
                            done_extra_fields[key] = value

            elif event_type == EventType.ERROR.value:
                error_msg = event.error or event.data.get("error", "Unknown error")
                yield _create_sse_event(
                    ResponsesAPIStreamEvents.ERROR.value,
                    create_error_event(
                        code="internal_error",
                        message=error_msg,
                    ),
                )
                return

            elif event_type == EventType.CANCELLED.value:
                yield _create_sse_event(
                    ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
                    {
                        "type": ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
                        "response": {
                            "id": response_id,
                            "object": "response",
                            "status": "incomplete",
                            "incomplete_details": {"reason": "cancelled"},
                        },
                    },
                )
                return

        # Send output_text.done event
        yield _create_sse_event(
            ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
            {
                "type": ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
                "item_id": item_id,
                "output_index": output_index,
                "content_index": content_index,
                "text": full_content,
            },
        )

        # Send content_part.done event
        yield _create_sse_event(
            ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
            {
                "type": ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
                "item_id": item_id,
                "output_index": output_index,
                "content_index": content_index,
                "part": {
                    "type": "output_text",
                    "text": full_content,
                    "annotations": (
                        [
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
                        if accumulated_sources
                        else []
                    ),
                },
            },
        )

        # Send output_item.done event
        yield _create_sse_event(
            ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            {
                "type": ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
                "output_index": output_index,
                "item": {
                    "type": "message",
                    "id": item_id,
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": full_content,
                            "annotations": [],
                        }
                    ],
                },
            },
        )

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
        response_data = create_response_completed_event(
            response_id=response_id,
            model=model_id,
            created_at=created_at,
            item_id=item_id,
            content=full_content,
            usage=usage_dict,
            sources=formatted_sources,
            blocks=accumulated_blocks if accumulated_blocks else None,
            stop_reason="silent_exit" if is_silent_exit else "end_turn",
            silent_exit=is_silent_exit if is_silent_exit else None,
            silent_exit_reason=silent_exit_reason if silent_exit_reason else None,
            **done_extra_fields,
        )

        logger.info(
            "[RESPONSE] Sending response.completed: subtask_id=%d, "
            "loaded_skills=%s, extra_fields=%s",
            subtask_id,
            response_data["response"].get("loaded_skills"),
            list(done_extra_fields.keys()),
        )

        yield _create_sse_event(
            ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
            response_data,
        )

    except asyncio.CancelledError:
        yield _create_sse_event(
            ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
            {
                "type": ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
                "response": {
                    "id": response_id,
                    "object": "response",
                    "status": "incomplete",
                    "incomplete_details": {"reason": "cancelled"},
                },
            },
        )

    except Exception as e:
        import traceback

        logger.error("[RESPONSE] Error: %s\n%s", e, traceback.format_exc())
        yield _create_sse_event(
            ResponsesAPIStreamEvents.ERROR.value,
            create_error_event(
                code="internal_error",
                message=str(e),
                details={"type": type(e).__name__},
            ),
        )

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
