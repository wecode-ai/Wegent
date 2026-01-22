# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket event emitter for Subscription/BackgroundExecution updates.

This module handles emitting real-time updates to connected clients
via Socket.IO when execution status changes.
"""

import json
import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.schemas.subscription import (
    BackgroundExecutionStatus,
    Subscription,
)

logger = logging.getLogger(__name__)


def emit_background_execution_update(
    db: Session,
    execution: BackgroundExecution,
    status: BackgroundExecutionStatus,
    result_summary: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    """
    Emit background:execution_update WebSocket event to notify frontend.

    Uses sync Redis publish to Socket.IO's internal channel to avoid
    asyncio event loop conflicts in Celery workers.

    Args:
        db: Database session
        execution: The BackgroundExecution record
        status: New execution status
        result_summary: Optional result summary
        error_message: Optional error message
    """
    # Get subscription details for the payload
    subscription_name: Optional[str] = None
    subscription_display_name: Optional[str] = None
    team_name: Optional[str] = None
    task_type: Optional[str] = None

    try:
        # Subscription is stored in kinds table with kind='Subscription'
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == execution.subscription_id,
                Kind.kind == "Subscription",
            )
            .first()
        )
        if subscription:
            subscription_crd = Subscription.model_validate(subscription.json)
            subscription_name = subscription.name
            subscription_display_name = subscription_crd.spec.displayName
            task_type = subscription_crd.spec.taskType.value

            # Get team info from teamRef
            team_ref = subscription_crd.spec.teamRef
            if team_ref:
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Team",
                        Kind.name == team_ref.name,
                        Kind.namespace == team_ref.namespace,
                    )
                    .first()
                )
                if team:
                    team_name = team.name
    except Exception as e:
        logger.warning(f"Failed to get subscription details for WS event: {e}")

    # Build payload
    is_silent = status == BackgroundExecutionStatus.COMPLETED_SILENT
    payload = {
        "execution_id": execution.id,
        "subscription_id": execution.subscription_id,
        "status": status.value,
        "is_silent": is_silent,  # Flag for silent executions
        "task_id": execution.task_id,
        "prompt": execution.prompt,
        "result_summary": result_summary or execution.result_summary,
        "error_message": error_message or execution.error_message,
        "trigger_reason": execution.trigger_reason,
        "created_at": (
            execution.created_at.isoformat() if execution.created_at else None
        ),
        "updated_at": (
            execution.updated_at.isoformat() if execution.updated_at else None
        ),
    }

    # Add optional fields
    if subscription_name:
        payload["subscription_name"] = subscription_name
    if subscription_display_name:
        payload["subscription_display_name"] = subscription_display_name
    if team_name:
        payload["team_name"] = team_name
    if task_type:
        payload["task_type"] = task_type

    # Publish to Socket.IO via sync Redis (works in Celery workers)
    try:
        import redis

        from app.core.config import settings

        # Use sync Redis client to publish to Socket.IO's internal channel
        redis_client = redis.from_url(settings.REDIS_URL, decode_responses=False)

        # Socket.IO AsyncRedisManager uses this channel format
        socketio_channel = "socketio"

        # Build Socket.IO internal message format
        socketio_message = {
            "method": "emit",
            "event": "background:execution_update",
            "data": [payload],
            "namespace": "/chat",
            "room": f"user:{execution.user_id}",
        }

        # Publish to Redis
        redis_client.publish(socketio_channel, json.dumps(socketio_message))
        redis_client.close()

        logger.debug(
            f"[WS] Published background:execution_update to Redis for execution={execution.id} "
            f"status={status.value} user_id={execution.user_id}"
        )
    except Exception as e:
        logger.error(
            f"[WS] Failed to publish background:execution_update to Redis: {e}",
            exc_info=True,
        )
