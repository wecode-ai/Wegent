# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task restore API endpoint.

This module provides the API endpoint for restoring expired tasks,
allowing users to continue conversations on tasks that have
exceeded their expiration time.
"""

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.adapters.task_restore import task_restore_service

router = APIRouter()


class RestoreTaskRequest(BaseModel):
    """Request body for restoring an expired task."""

    message: Optional[str] = None  # Optional message to send after restoration


class RestoreTaskResponse(BaseModel):
    """Response for task restoration operation."""

    success: bool
    task_id: int
    task_type: str
    executor_rebuilt: bool
    message: str


@router.post("/{task_id}/restore", response_model=RestoreTaskResponse)
def restore_task(
    task_id: int,
    request: RestoreTaskRequest = RestoreTaskRequest(),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Restore an expired task to continue the conversation.

    This endpoint allows users to continue conversations on tasks that have
    exceeded their expiration time (2 hours for chat, 24 hours for code).

    When a task is restored:
    - The task's updated_at timestamp is reset
    - If the executor container was cleaned up, it will be recreated
      when the next message is sent
    - All conversation history is preserved

    Args:
        task_id: ID of the task to restore
        request: Optional request body containing message to send after restoration
        current_user: Current authenticated user
        db: Database session

    Returns:
        RestoreTaskResponse with success status and details

    Raises:
        404: Task not found or user doesn't have access
        400: Task cannot be restored (wrong status or already cleared)
    """
    return task_restore_service.restore_task(
        db=db,
        task_id=task_id,
        user=current_user,
        message=request.message,
    )
