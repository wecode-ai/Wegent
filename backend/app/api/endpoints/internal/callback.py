# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified callback API for execution events.

This module provides a unified callback endpoint for receiving execution events
from different sources (executor_manager, device, etc.) and forwarding them
to the frontend via WebSocket.

This is part of the Phase 3 refactoring to unify task dispatch architecture.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.services.execution.emitters.websocket import WebSocketResultEmitter
from shared.models import EventType, ExecutionEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/callback", tags=["execution-callback"])


class CallbackRequest(BaseModel):
    """Request model for execution callback."""

    type: str = Field(
        ..., description="Event type (start, chunk, done, error, progress)"
    )
    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    content: Optional[str] = Field(None, description="Content for chunk events")
    offset: Optional[int] = Field(None, description="Offset for chunk events")
    result: Optional[dict] = Field(None, description="Result data for done events")
    error: Optional[str] = Field(None, description="Error message for error events")
    message_id: Optional[int] = Field(None, description="Message ID for ordering")
    progress: Optional[int] = Field(None, description="Progress percentage")
    status: Optional[str] = Field(None, description="Status for progress events")


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

    This endpoint receives execution events from executors and forwards them
    to the frontend via WebSocketResultEmitter.

    Unified event handling:
    - Uses WebSocketResultEmitter to emit events to WebSocket
    - Supports all event types: start, chunk, done, error, progress

    Args:
        request: Callback request with event data
        db: Database session

    Returns:
        CallbackResponse indicating success
    """
    logger.info(
        f"[Callback] Received event: type={request.type}, "
        f"task_id={request.task_id}, subtask_id={request.subtask_id}"
    )

    try:
        # Parse event type
        try:
            event_type = EventType(request.type)
        except ValueError:
            logger.warning(f"[Callback] Unknown event type: {request.type}")
            raise HTTPException(
                status_code=400, detail=f"Unknown event type: {request.type}"
            )

        # Create execution event
        event = ExecutionEvent(
            type=event_type,
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            content=request.content or "",
            offset=request.offset or 0,
            result=request.result,
            error=request.error,
            message_id=request.message_id,
            progress=request.progress,
            status=request.status,
        )

        # Emit event via WebSocketResultEmitter
        emitter = WebSocketResultEmitter(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
        )
        await emitter.emit(event)
        await emitter.close()

        logger.info(
            f"[Callback] Event emitted: type={event_type.value}, "
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

    This endpoint receives multiple execution events and processes them in order.

    Args:
        events: List of callback requests
        db: Database session

    Returns:
        CallbackResponse indicating success
    """
    logger.info(f"[Callback] Received batch of {len(events)} events")

    processed = 0
    errors = []

    for request in events:
        try:
            # Parse event type
            try:
                event_type = EventType(request.type)
            except ValueError:
                errors.append(f"Unknown event type: {request.type}")
                continue

            # Create execution event
            event = ExecutionEvent(
                type=event_type,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                content=request.content or "",
                offset=request.offset or 0,
                result=request.result,
                error=request.error,
                message_id=request.message_id,
                progress=request.progress,
                status=request.status,
            )

            # Emit event via WebSocketResultEmitter
            emitter = WebSocketResultEmitter(
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

    logger.info(f"[Callback] Batch processed: {processed}/{len(events)} events")

    if errors:
        return CallbackResponse(
            status="partial",
            message=f"Processed {processed}/{len(events)} events. Errors: {'; '.join(errors[:5])}",
        )

    return CallbackResponse(status="ok", message=f"Processed {processed} events")
