# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task revival API endpoint.

This module provides the API endpoint for reviving expired tasks,
allowing users to continue conversations on tasks that have
exceeded their expiration time.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.adapters.task_revive import task_revive_service

router = APIRouter()
logger = logging.getLogger(__name__)


class ReviveTaskRequest(BaseModel):
    """Request body for reviving an expired task."""

    message: Optional[str] = None  # Optional message to send after revival


class ReviveTaskResponse(BaseModel):
    """Response for task revival operation."""

    success: bool
    task_id: int
    task_type: str
    executor_rebuilt: bool
    message: str


@router.post("/{task_id}/revive", response_model=ReviveTaskResponse)
def revive_task(
    task_id: int,
    request: ReviveTaskRequest = ReviveTaskRequest(),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Revive an expired task to continue the conversation.

    This endpoint allows users to continue conversations on tasks that have
    exceeded their expiration time (2 hours for chat, 24 hours for code).

    When a task is revived:
    - The task's updated_at timestamp is reset
    - If the executor container was cleaned up, it will be recreated
      when the next message is sent
    - All conversation history is preserved

    Args:
        task_id: ID of the task to revive
        request: Optional request body containing message to send after revival
        current_user: Current authenticated user
        db: Database session

    Returns:
        ReviveTaskResponse with success status and details

    Raises:
        404: Task not found or user doesn't have access
        400: Task cannot be revived (wrong status or already cleared)
    """
    return task_revive_service.revive_task(
        db=db,
        task_id=task_id,
        user=current_user,
        message=request.message,
    )
