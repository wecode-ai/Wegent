# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
/v1/execute API endpoint implementation.

This endpoint provides a unified execution interface that accepts
ExecutionRequest format and returns SSE stream with ExecutionEvent format.

Uses unified data protocol from shared.models.execution.
"""

import asyncio
import logging
import uuid
from typing import Any, AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from chat_shell.services.chat_service import chat_service
from shared.models.execution import EventType, ExecutionEvent, ExecutionRequest

router = APIRouter(prefix="/v1", tags=["execute"])

logger = logging.getLogger(__name__)

# Track active executions for cancellation
_active_executions: dict[str, asyncio.Event] = {}


class CancelExecuteRequest(BaseModel):
    """Cancel execute request schema."""

    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")


class CancelExecuteResponse(BaseModel):
    """Cancel execute response schema."""

    status: str = Field(..., description="Status: ok or error")
    message: str = Field("", description="Status message")


async def _stream_execution(
    request: ExecutionRequest,
    cancel_event: asyncio.Event,
    execution_id: str,
) -> AsyncGenerator[str, None]:
    """Stream execution events using unified ExecutionEvent format.

    Args:
        request: ExecutionRequest from unified data protocol
        cancel_event: Event for cancellation
        execution_id: Unique execution ID

    Yields:
        SSE formatted events using ExecutionEvent.to_sse()
    """
    from chat_shell.core.shutdown import shutdown_manager

    # Register stream with shutdown manager
    await shutdown_manager.register_stream(execution_id)

    task_id = request.task_id
    subtask_id = request.subtask_id
    full_content = ""
    offset = 0

    try:
        # Emit start event using ExecutionEvent
        start_event = ExecutionEvent.create(
            event_type=EventType.START,
            task_id=task_id,
            subtask_id=subtask_id,
        )
        yield start_event.to_sse()

        logger.info(
            "[EXECUTE] Processing request: task_id=%d, subtask_id=%d, prompt_len=%d",
            task_id,
            subtask_id,
            len(request.prompt),
        )

        # Stream from ChatService - now directly uses ExecutionRequest
        async for event in chat_service.chat(request):
            # Check for cancellation
            if cancel_event.is_set():
                cancel_event_obj = ExecutionEvent.create(
                    event_type=EventType.CANCEL,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=full_content,
                    offset=offset,
                )
                yield cancel_event_obj.to_sse()
                return

            # Process ExecutionEvent - event.type is now a string (EventType value)
            event_type = event.type
            if event_type == EventType.CHUNK.value:
                chunk_text = event.content or event.data.get("content", "")
                if chunk_text:
                    full_content += chunk_text
                    chunk_event = ExecutionEvent.create(
                        event_type=EventType.CHUNK,
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=chunk_text,
                        offset=offset,
                    )
                    yield chunk_event.to_sse()
                    offset += len(chunk_text)

            elif event_type == EventType.DONE.value:
                # Extract result data
                result = event.result or event.data.get("result", {})
                done_event = ExecutionEvent.create(
                    event_type=EventType.DONE,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    offset=offset,
                    result=result,
                )
                yield done_event.to_sse()

            elif event_type == EventType.ERROR.value:
                error_msg = event.error or event.data.get("error", "Unknown error")
                error_event = ExecutionEvent.create(
                    event_type=EventType.ERROR,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    offset=offset,
                    error=error_msg,
                )
                yield error_event.to_sse()
                return

            elif event_type == EventType.CANCELLED.value:
                cancelled_event = ExecutionEvent.create(
                    event_type=EventType.CANCELLED,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=full_content,
                    offset=offset,
                )
                yield cancelled_event.to_sse()
                return

            elif event_type == EventType.THINKING.value:
                # Map thinking to thinking event
                thinking_text = event.content or event.data.get("content", "")
                if thinking_text:
                    thinking_event = ExecutionEvent.create(
                        event_type=EventType.THINKING,
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=thinking_text,
                        offset=offset,
                    )
                    yield thinking_event.to_sse()

            elif event_type == EventType.TOOL_START.value:
                # Map tool start event
                tool_name = event.tool_name or event.data.get("tool_name", "")
                tool_use_id = event.tool_use_id or event.data.get("tool_call_id", "")
                tool_input = event.tool_input or event.data.get("tool_input", {})
                tool_start_event = ExecutionEvent.create(
                    event_type=EventType.TOOL_START,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    tool_name=tool_name,
                    tool_use_id=tool_use_id,
                    tool_input=tool_input,
                    offset=offset,
                )
                yield tool_start_event.to_sse()

            elif event_type == EventType.TOOL_RESULT.value:
                # Map tool result event
                tool_name = event.tool_name or event.data.get("tool_name", "")
                tool_use_id = event.tool_use_id or event.data.get("tool_call_id", "")
                tool_output = (
                    event.tool_output
                    if event.tool_output is not None
                    else event.data.get("tool_output")
                )
                tool_result_event = ExecutionEvent.create(
                    event_type=EventType.TOOL_RESULT,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    tool_name=tool_name,
                    tool_use_id=tool_use_id,
                    tool_output=tool_output,
                    offset=offset,
                )
                yield tool_result_event.to_sse()

        # Send final done marker
        yield "data: [DONE]\n\n"

    except asyncio.CancelledError:
        cancel_event_obj = ExecutionEvent.create(
            event_type=EventType.CANCEL,
            task_id=task_id,
            subtask_id=subtask_id,
            content=full_content,
            offset=offset,
        )
        yield cancel_event_obj.to_sse()

    except Exception as e:
        import traceback

        logger.error("[EXECUTE] Error: %s\n%s", e, traceback.format_exc())
        error_event = ExecutionEvent.create(
            event_type=EventType.ERROR,
            task_id=task_id,
            subtask_id=subtask_id,
            offset=offset,
            error=str(e),
        )
        yield error_event.to_sse()

    finally:
        # Unregister stream from shutdown manager
        await shutdown_manager.unregister_stream(execution_id)
        # Clean up from active executions
        _cleanup_execution(execution_id)


def _cleanup_execution(execution_id: str):
    """Clean up execution resources after completion."""
    if execution_id in _active_executions:
        del _active_executions[execution_id]


def _get_execution_key(task_id: int, subtask_id: int) -> str:
    """Get execution key for tracking."""
    return f"{task_id}:{subtask_id}"


@router.post("/execute")
async def execute(request_data: dict[str, Any], req: Request):
    """Unified execution endpoint.

    Accepts ExecutionRequest format (as dict) and returns SSE stream
    with ExecutionEvent format.

    Uses ExecutionRequest.from_dict() to parse the request data,
    enabling unified data protocol across all modules.

    Args:
        request_data: Request data dict (will be parsed to ExecutionRequest)
        req: FastAPI Request object

    Returns:
        StreamingResponse with SSE events
    """
    from shared.telemetry.context import set_request_context

    # Parse request data using unified ExecutionRequest.from_dict()
    request = ExecutionRequest.from_dict(request_data)

    # Generate execution ID
    execution_id = req.headers.get("X-Request-ID")
    if not execution_id:
        execution_id = f"exec-{uuid.uuid4().hex[:12]}"

    # Set request context for log correlation
    set_request_context(execution_id)

    # Create cancel event for this execution
    cancel_event = asyncio.Event()

    # Track by task_id:subtask_id for cancellation
    execution_key = _get_execution_key(request.task_id, request.subtask_id)
    _active_executions[execution_key] = cancel_event

    logger.info(
        "[EXECUTE] Starting execution: task_id=%d, subtask_id=%d, execution_id=%s",
        request.task_id,
        request.subtask_id,
        execution_id,
    )

    return StreamingResponse(
        _stream_execution(request, cancel_event, execution_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Request-ID": execution_id,
        },
    )


@router.post("/cancel")
async def cancel(request: CancelExecuteRequest):
    """Cancel an ongoing execution.

    Args:
        request: CancelExecuteRequest with task_id and subtask_id

    Returns:
        CancelExecuteResponse with status
    """
    execution_key = _get_execution_key(request.task_id, request.subtask_id)

    logger.info(
        "[EXECUTE] Cancel request: task_id=%d, subtask_id=%d",
        request.task_id,
        request.subtask_id,
    )

    if execution_key not in _active_executions:
        return CancelExecuteResponse(
            status="error",
            message="Execution not found or already completed",
        )

    cancel_event = _active_executions.get(execution_key)
    if cancel_event:
        cancel_event.set()
        # Also cancel via chat_service for proper cleanup
        await chat_service.cancel(request.subtask_id)
        return CancelExecuteResponse(
            status="ok",
            message="Execution cancelled",
        )

    return CancelExecuteResponse(
        status="error",
        message="Execution not found",
    )
