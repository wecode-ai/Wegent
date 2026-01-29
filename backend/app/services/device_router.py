# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device task router service.

This module handles routing tasks to local devices via WebSocket.
It reuses executor_kinds._format_subtasks_response() to ensure
the task data format is identical to what executor_manager receives.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.device_service import device_service

logger = logging.getLogger(__name__)


async def route_task_to_device(
    db: Session,
    user_id: int,
    device_id: str,
    task: TaskResource,
    subtask: Subtask,
    team: Kind,
    user: User,
    auth_token: str = "",
    user_subtask: Optional[Subtask] = None,
) -> bool:
    """
    Route a task to a local device for execution.

    This function:
    1. Verifies device is online
    2. Formats task data using executor_kinds (same format as executor_manager)
    3. Updates subtask with device executor info
    4. Pushes task to device via WebSocket

    Args:
        db: Database session
        user_id: User ID
        device_id: Target device ID
        task: Task resource
        subtask: Assistant subtask to execute
        team: Team Kind
        user: User object
        auth_token: JWT token for API calls
        user_subtask: Optional user subtask for context retrieval

    Returns:
        True if task was successfully routed to device

    Raises:
        HTTPException: If device is offline or routing fails
    """
    from fastapi import HTTPException

    # Verify device is online
    device_info = await device_service.get_device_online_info(user_id, device_id)
    if not device_info:
        raise HTTPException(status_code=400, detail="Selected device is offline")

    # Re-query ORM objects within this session to avoid cross-session issues
    # This is necessary because the passed objects may be bound to a different session
    local_subtask = db.query(Subtask).filter(Subtask.id == subtask.id).first()

    if not local_subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Update subtask with device executor info
    local_subtask.executor_name = f"device-{device_id}"
    local_subtask.executor_namespace = f"user-{user_id}"
    local_subtask.status = SubtaskStatus.RUNNING
    local_subtask.started_at = datetime.now()
    db.add(local_subtask)
    db.commit()

    # Refresh to get updated state
    db.refresh(local_subtask)

    # Use executor_kinds_service to format task data (same format as executor_manager)
    # This ensures device receives identical structure to what executor_manager dispatches
    formatted_result = executor_kinds_service._format_subtasks_response(
        db, [local_subtask]
    )

    if not formatted_result.get("tasks"):
        raise HTTPException(status_code=500, detail="Failed to format task data")

    task_data = formatted_result["tasks"][0]

    # Push task to device via WebSocket
    from app.core.socketio import get_sio

    sio = get_sio()
    device_room = f"device:{user_id}:{device_id}"

    await sio.emit(
        "task:execute", task_data, room=device_room, namespace="/local-executor"
    )

    logger.info(
        f"[DeviceRouter] Task routed to device: task_id={task.id}, "
        f"subtask_id={subtask.id}, device_id={device_id}"
    )

    return True
