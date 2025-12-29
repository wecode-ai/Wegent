# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cancel operation utilities for Chat Service.

This module provides utilities for cancelling chat streams and updating
subtask status on cancellation.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task

logger = logging.getLogger(__name__)


async def cancel_chat_stream(
    subtask_id: int,
    shell_type: Optional[str] = None,
    stream_versions: Optional[dict] = None,
) -> None:
    """
    Cancel a chat stream based on shell type.

    For Chat Shell tasks, uses session_manager.
    For Executor tasks, calls executor_manager API.

    Args:
        subtask_id: Subtask ID to cancel
        shell_type: Shell type (e.g., "Chat", "ClaudeCode")
        stream_versions: Dict mapping subtask_id to stream version ("v1" or "v2")
    """
    is_chat_shell = shell_type == "Chat" if shell_type else False

    if is_chat_shell:
        # For Chat Shell tasks, determine which session_manager to use
        stream_version = (
            stream_versions.get(subtask_id, "v1") if stream_versions else "v1"
        )

        if stream_version == "v2":
            logger.info(f"Using chat session_manager (v2) for subtask_id={subtask_id}")
            from app.services.chat.storage import session_manager as session_manager_v2

            await session_manager_v2.cancel_stream(subtask_id)
        else:
            logger.info(f"Using chat session_manager (v1) for subtask_id={subtask_id}")
            from app.services.chat.storage import session_manager

            await session_manager.cancel_stream(subtask_id)
    else:
        # For Executor tasks, call executor_manager API
        # Get task_id from subtask
        from app.db.session import SessionLocal
        from app.services.chat.operations.executor import call_executor_cancel

        db = SessionLocal()
        try:
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            if subtask:
                await call_executor_cancel(subtask.task_id)
        finally:
            db.close()


def update_subtask_on_cancel(
    db: Session,
    subtask: Subtask,
    partial_content: Optional[str] = None,
) -> None:
    """
    Update subtask status and result on cancellation.

    Args:
        db: Database session
        subtask: Subtask to update
        partial_content: Optional partial content to save
    """
    subtask.status = SubtaskStatus.COMPLETED
    subtask.progress = 100
    subtask.completed_at = datetime.now()
    subtask.updated_at = datetime.now()

    if partial_content:
        subtask.result = {"value": partial_content}
    else:
        subtask.result = {"value": ""}


def update_task_on_cancel(db: Session, task: TaskResource) -> None:
    """
    Update task status on cancellation.

    Args:
        db: Database session
        task: Task to update
    """
    from sqlalchemy.orm.attributes import flag_modified

    task_crd = Task.model_validate(task.json)
    if task_crd.status:
        task_crd.status.status = "COMPLETED"
        task_crd.status.errorMessage = ""
        task_crd.status.updatedAt = datetime.now()
        task_crd.status.completedAt = datetime.now()

    task.json = task_crd.model_dump(mode="json")
    task.updated_at = datetime.now()
    flag_modified(task, "json")
