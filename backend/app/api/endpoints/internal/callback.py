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

For terminal events (DONE, ERROR, CANCELLED), StatusUpdatingEmitter handles:
1. Database status updates
2. Publishing TaskCompletedEvent for unified handling by SubscriptionTaskCompletionHandler
"""

import logging
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.db.session import SessionLocal
from app.models.task import TaskResource

# Import channel callback modules to ensure they register with
# ChannelCallbackRegistry in this worker process. Without these imports,
# the registry may be empty when /callback is handled by a different worker
# than the one that processed the original IM message.
from app.services.channels.dingtalk import callback as _dingtalk_cb  # noqa: F401
from app.services.channels.telegram import callback as _telegram_cb  # noqa: F401
from app.services.chat.storage import session_manager
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from app.services.execution.emitters.websocket import WebSocketResultEmitter
from app.services.execution.response_parser import ResponsesAPIEventParser
from app.stores.tasks import task_store
from shared.models import EventType

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/callback", tags=["execution-callback"])

# Shared event parser instance
_event_parser = ResponsesAPIEventParser()

_TASK_STATUS_EVENT_TYPES = {
    EventType.DONE.value,
    EventType.ERROR.value,
    EventType.CANCEL.value,
    EventType.CANCELLED.value,
}


def _get_task_status_user_id(task_id: int, event_type: str) -> Optional[int]:
    """Load task owner only for events that emit task-level status."""
    if event_type not in _TASK_STATUS_EVENT_TYPES:
        return None

    with SessionLocal() as db:
        task = task_store.get_task_by_states(
            db,
            task_id=task_id,
            states=[TaskResource.STATE_ACTIVE],
        )
        return task.user_id if task else None


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


@router.post("/batch", response_model=CallbackResponse)
async def handle_batch_callback(
    events: list[CallbackRequest],
) -> CallbackResponse:
    """Handle batch execution callbacks.

    This endpoint receives multiple execution events in OpenAI Responses API format
    and processes them in order.

    For terminal events (DONE, ERROR, CANCELLED), StatusUpdatingEmitter handles:
    - Database status updates
    - Publishing TaskCompletedEvent for unified handling

    Args:
        events: List of callback requests in OpenAI Responses API format
    Returns:
        CallbackResponse indicating success
    """
    logger.info(f"[Callback] Received batch of {len(events)} events")

    processed = 0
    skipped = 0
    errors = []

    # Cache task_id -> user_id mapping to avoid repeated database queries
    task_user_cache: dict[int, Optional[int]] = {}

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

            # Load task owner only for terminal events. The helper closes its
            # short-lived session before any async emit work starts.
            cache_key = request.task_id
            if event.type in _TASK_STATUS_EVENT_TYPES:
                if cache_key not in task_user_cache:
                    task_user_cache[cache_key] = _get_task_status_user_id(
                        request.task_id,
                        event.type,
                    )
                user_id = task_user_cache[cache_key]
            else:
                user_id = None

            # Emit event via WebSocketResultEmitter wrapped with StatusUpdatingEmitter
            # StatusUpdatingEmitter handles:
            # 1. Database status updates (including executor_name for container reuse)
            # 2. Publishing TaskCompletedEvent for unified handling
            ws_emitter = WebSocketResultEmitter(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                user_id=user_id,
            )
            emitter = StatusUpdatingEmitter(
                wrapped=ws_emitter,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                executor_name=request.executor_name,
                executor_namespace=request.executor_namespace,
            )
            await emitter.emit(event)
            await emitter.close()

            # Publish to the callback stream channel so active OpenAI
            # v1/responses SSE consumers receive the device events. Without
            # this, a batch reporting executor updates the database while the
            # response stream stalls after its first events.
            await session_manager.publish_callback_event(request.subtask_id, event)

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
