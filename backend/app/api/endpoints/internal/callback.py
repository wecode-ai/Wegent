# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified callback API for execution events.

This module provides a unified callback endpoint for receiving execution events
from different sources (executor_manager, device, etc.) and forwarding them
to the frontend via WebSocket.

All callback events use OpenAI Responses API format for consistency with SSE mode.
The ResponsesAPIEventParser is used to parse events into ExecutionEvent format.
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.services.execution.dispatcher import ResponsesAPIEventParser
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from app.services.execution.emitters.websocket import WebSocketResultEmitter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/callback", tags=["execution-callback"])

# Shared event parser instance
_event_parser = ResponsesAPIEventParser()


class CallbackRequest(BaseModel):
    """Request model for execution callback.

    Uses OpenAI Responses API format for consistency with SSE mode.
    The event_type field corresponds to ResponsesAPIStreamEvents values.
    """

    # OpenAI Responses API format fields
    event_type: str = Field(
        ...,
        description="OpenAI Responses API event type (e.g., response.output_text.delta)",
    )
    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    message_id: Optional[int] = Field(None, description="Message ID for ordering")
    executor_name: Optional[str] = Field(None, description="Executor name")
    executor_namespace: Optional[str] = Field(None, description="Executor namespace")
    data: dict = Field(
        default_factory=dict,
        description="Event data in OpenAI Responses API format",
    )


class CallbackResponse(BaseModel):
    """Response model for execution callback."""

    status: str = "ok"
    message: Optional[str] = None


@router.post("", response_model=CallbackResponse)
async def handle_callback(
    request: CallbackRequest,
    db: Session = Depends(get_db),
) -> CallbackResponse:
    """Handle execution callback.

    This endpoint receives execution events in OpenAI Responses API format
    from executors and forwards them to the frontend via WebSocketResultEmitter.

    The event format is the same as SSE mode, ensuring consistency across
    all execution modes (SSE, callback, device).

    Args:
        request: Callback request with event data in OpenAI Responses API format
        db: Database session

    Returns:
        CallbackResponse indicating success
    """
    logger.info(
        f"[Callback] Received event: event_type={request.event_type}, "
        f"task_id={request.task_id}, subtask_id={request.subtask_id}"
    )

    try:
        # Parse OpenAI Responses API event using shared parser
        event = _event_parser.parse(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            event_type=request.event_type,
            data=request.data,
        )

        if event is None:
            # Lifecycle events are skipped
            logger.debug(f"[Callback] Skipping lifecycle event: {request.event_type}")
            return CallbackResponse(status="ok", message="Lifecycle event skipped")

        # Emit event via WebSocketResultEmitter wrapped with StatusUpdatingEmitter
        # StatusUpdatingEmitter intercepts terminal events (DONE, ERROR, CANCELLED)
        # and updates the database status accordingly
        ws_emitter = WebSocketResultEmitter(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
        )
        emitter = StatusUpdatingEmitter(
            wrapped=ws_emitter,
            task_id=request.task_id,
            subtask_id=request.subtask_id,
        )
        await emitter.emit(event)
        await emitter.close()

        logger.info(
            f"[Callback] Event emitted: type={event.type}, "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

        return CallbackResponse(status="ok")

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"[Callback] Error handling callback: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/batch", response_model=CallbackResponse)
async def handle_batch_callback(
    events: list[CallbackRequest],
    db: Session = Depends(get_db),
) -> CallbackResponse:
    """Handle batch execution callbacks.

    This endpoint receives multiple execution events in OpenAI Responses API format
    and processes them in order.

    Args:
        events: List of callback requests in OpenAI Responses API format
        db: Database session

    Returns:
        CallbackResponse indicating success
    """
    logger.info(f"[Callback] Received batch of {len(events)} events")

    processed = 0
    skipped = 0
    errors = []

    for request in events:
        try:
            # Parse OpenAI Responses API event using shared parser
            event = _event_parser.parse(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                message_id=request.message_id,
                event_type=request.event_type,
                data=request.data,
            )

            if event is None:
                # Lifecycle events are skipped
                skipped += 1
                continue

            # Emit event via WebSocketResultEmitter wrapped with StatusUpdatingEmitter
            ws_emitter = WebSocketResultEmitter(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
            )
            emitter = StatusUpdatingEmitter(
                wrapped=ws_emitter,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
            )
            await emitter.emit(event)
            await emitter.close()
            processed += 1

        except Exception as e:
            errors.append(
                f"Error processing event for subtask {request.subtask_id}: {str(e)}"
            )

    logger.info(
        f"[Callback] Batch processed: {processed}/{len(events)} events, "
        f"{skipped} skipped"
    )

    if errors:
        return CallbackResponse(
            status="partial",
            message=f"Processed {processed}/{len(events)} events. Errors: {'; '.join(errors[:5])}",
        )

    return CallbackResponse(
        status="ok",
        message=f"Processed {processed} events, {skipped} skipped",
    )
