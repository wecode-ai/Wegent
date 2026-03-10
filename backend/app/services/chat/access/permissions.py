# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task access permission utilities for Chat Service.

This module provides utilities for checking task access permissions,
including ownership and group membership checks.
Uses the unified ResourceMember model for access control.
"""

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource

logger = logging.getLogger(__name__)


async def can_access_task(user_id: int, task_id: int) -> bool:
    """
    Check if user can access a task.

    Supports:
    - Task ownership
    - Resource membership (via ResourceMember with status=approved)

    Args:
        user_id: User ID
        task_id: Task ID

    Returns:
        True if user can access the task
    """
    db = SessionLocal()
    try:
        return can_access_task_sync(db, user_id, task_id)
    finally:
        db.close()


def can_access_task_sync(db: Session, user_id: int, task_id: int) -> bool:
    """
    Synchronous version of can_access_task.

    Args:
        db: Database session
        user_id: User ID
        task_id: Task ID

    Returns:
        True if user can access the task
    """
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
    )

    if not task:
        return False

    # User owns the task
    if task.user_id == user_id:
        return True

    # Check if user is a member via ResourceMember (includes shared tasks and group chat members)
    from app.models.resource_member import MemberStatus, ResourceMember
    from app.models.share_link import ResourceType

    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.TASK,
            ResourceMember.resource_id == task_id,
            ResourceMember.user_id == user_id,
            ResourceMember.status == MemberStatus.APPROVED,
        )
        .first()
    )

    return member is not None


async def get_active_streaming(task_id: int) -> Optional[Dict[str, Any]]:
    """
    Check if there's an active streaming session for a task.

    Priority:
    1. Check Redis task_streaming_status (real-time, set when stream starts)
    2. Fall back to database query (delayed, updated every 5 seconds)

    Args:
        task_id: Task ID

    Returns:
        Streaming info dict if active, None otherwise
    """
    from app.services.chat.storage import session_manager

    logger.info(
        f"[get_active_streaming] Checking streaming status for task_id={task_id}"
    )

    # First, check Redis for real-time streaming status
    # This is set immediately when streaming starts, before DB update
    redis_status = await session_manager.get_task_streaming_status(task_id)
    logger.info(
        f"[get_active_streaming] Redis task_streaming_status for task_id={task_id}: {redis_status}"
    )

    if redis_status:
        subtask_id = redis_status.get("subtask_id")
        # Also get cached content to verify stream is active
        cached_content = await session_manager.get_streaming_content(subtask_id)
        logger.info(
            f"[get_active_streaming] Found Redis streaming status for task {task_id}: "
            f"subtask_id={subtask_id}, cached_content_len={len(cached_content) if cached_content else 0}"
        )
        return redis_status

    # Fall back to database query if Redis doesn't have the status
    # This handles the case where Redis data expired or was cleared
    logger.info(
        f"[get_active_streaming] No Redis status, falling back to DB query for task_id={task_id}"
    )
    db = SessionLocal()
    try:
        # Find running assistant subtask
        subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.RUNNING,
            )
            .order_by(Subtask.id.desc())
            .first()
        )

        if subtask:
            logger.info(
                f"[get_active_streaming] Found DB streaming subtask for task {task_id}: "
                f"subtask_id={subtask.id}, status={subtask.status}"
            )
            return {
                "subtask_id": subtask.id,
                "user_id": subtask.user_id,
                "started_at": (
                    subtask.created_at.isoformat() if subtask.created_at else None
                ),
            }

        logger.info(
            f"[get_active_streaming] No active streaming found for task_id={task_id}"
        )
        return None

    finally:
        db.close()
