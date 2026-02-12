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

For terminal events (DONE, ERROR), TaskCompletedEvent is published for unified handling
by SubscriptionTaskCompletionHandler.
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.events import TaskCompletedEvent, get_event_bus
from app.models.task import TaskResource
from app.services.execution.dispatcher import ResponsesAPIEventParser
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from app.services.execution.emitters.websocket import WebSocketResultEmitter
from shared.models import EventType

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

    For terminal events (DONE, ERROR), TaskCompletedEvent is published for
    unified handling by SubscriptionTaskCompletionHandler.

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

        # Handle terminal events - publish TaskCompletedEvent for unified handling
        if event.type in (
            EventType.DONE.value,
            EventType.ERROR.value,
            EventType.CANCELLED.value,
        ):
            await _publish_task_completed_event(db, request, event)

        return CallbackResponse(status="ok")

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"[Callback] Error handling callback: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _publish_task_completed_event(
    db: Session,
    request: CallbackRequest,
    event: Any,
) -> None:
    """Publish TaskCompletedEvent for terminal events.

    Args:
        db: Database session
        request: Original callback request
        event: Parsed execution event
    """
    try:
        # Get task to find user_id
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == request.task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if not task:
            logger.warning(
                f"[Callback] Cannot publish TaskCompletedEvent: "
                f"task {request.task_id} not found"
            )
            return

        # Determine status and result/error
        if event.type == EventType.DONE.value:
            status = "COMPLETED"
            result = event.result if hasattr(event, "result") else None
            error = None
        elif event.type == EventType.ERROR.value:
            status = "FAILED"
            result = None
            error = event.error if hasattr(event, "error") else "Unknown error"
        else:  # CANCELLED
            status = "CANCELLED"
            result = None
            error = None

        # Publish TaskCompletedEvent
        event_bus = get_event_bus()
        await event_bus.publish(
            TaskCompletedEvent(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                user_id=task.user_id,
                status=status,
                result=result,
                error=error,
            )
        )

        logger.info(
            f"[Callback] Published TaskCompletedEvent: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}, "
            f"status={status}"
        )

    except Exception as e:
        # Don't fail the callback if event publishing fails
        logger.error(
            f"[Callback] Failed to publish TaskCompletedEvent: {e}",
            exc_info=True,
        )


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

            # Handle terminal events
            if event.type in (
                EventType.DONE.value,
                EventType.ERROR.value,
                EventType.CANCELLED.value,
            ):
                await _publish_task_completed_event(db, request, event)

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
