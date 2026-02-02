# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task restore service for expired tasks.

This module provides functionality to restore expired tasks,
allowing users to continue conversations on tasks that have
exceeded their expiration time.

For code tasks with workspace archives, it also marks the task
for workspace restoration so the executor can restore files.
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.adapters.workspace_archive import (
    is_workspace_archive_enabled,
    workspace_archive_service,
)
from app.services.task_member_service import task_member_service

logger = logging.getLogger(__name__)


class TaskRestoreService:
    """Service for restoring expired tasks."""

    def restore_task(
        self,
        db: Session,
        task_id: int,
        user: User,
        message: Optional[str] = None,
    ) -> dict:
        """
        Restore an expired task.

        This method:
        1. Validates task exists and user has access
        2. Validates task is in a restorable state
        3. Resets task updated_at timestamp
        4. Checks if executor needs rebuilding
        5. For code tasks, marks workspace for restoration if archive exists
        6. Optionally creates new subtasks if message is provided

        Args:
            db: Database session
            task_id: ID of the task to restore
            user: Current user
            message: Optional message to send after restoration

        Returns:
            Dict with success status and restoration details

        Raises:
            HTTPException: If task not found, not accessible, or not restorable
        """
        # 1. Get task and validate access
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Check if user has access to the task
        if not task_member_service.is_member(db, task_id, user.id):
            raise HTTPException(status_code=404, detail="Task not found")

        # 2. Validate task status is restorable
        task_crd = Task.model_validate(task.json)
        task_status = task_crd.status.status if task_crd.status else "PENDING"

        restorable_states = ["COMPLETED", "FAILED", "CANCELLED", "PENDING_CONFIRMATION"]
        if task_status not in restorable_states:
            raise HTTPException(
                status_code=400,
                detail=f"Task cannot be restored. Current status: {task_status}",
            )

        # Check if task was auto-deleted
        if (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("autoDeleteExecutor") == "true"
        ):
            raise HTTPException(
                status_code=400,
                detail="Task has been cleared and cannot be restored",
            )

        # 3. Get task type for determining expiration
        task_type = (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("taskType")
            or "chat"
        )

        # 4. Check if executor needs rebuilding
        executor_rebuilt = self._rebuild_executor_if_needed(db, task_id)

        # 5. For code tasks, mark workspace for restoration if archive exists
        workspace_restore_marked = False
        if task_type == "code" and executor_rebuilt:
            workspace_restore_marked = self._mark_workspace_for_restore(db, task_id)

        # 6. Reset task timestamp
        task.updated_at = datetime.now()
        if task_crd.status:
            task_crd.status.updatedAt = datetime.now()
        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        flag_modified(task, "json")

        db.commit()
        db.refresh(task)

        logger.info(
            f"Task {task_id} restored successfully by user {user.id}, "
            f"executor_rebuilt={executor_rebuilt}, "
            f"workspace_restore_marked={workspace_restore_marked}"
        )

        return {
            "success": True,
            "task_id": task_id,
            "task_type": task_type,
            "executor_rebuilt": executor_rebuilt,
            "workspace_restore_pending": workspace_restore_marked,
            "message": "Task restored successfully",
        }

    def _rebuild_executor_if_needed(self, db: Session, task_id: int) -> bool:
        """
        Check if executor needs rebuilding and reset the deleted flag.

        For tasks where executor has been cleaned up (executor_deleted_at=True),
        we need to reset this flag so a new executor can be created when
        the next message is sent.

        Args:
            db: Database session
            task_id: Task ID to check

        Returns:
            True if executor was marked for rebuild, False otherwise
        """
        # Get the last assistant subtask with executor info
        last_assistant_subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.executor_name.isnot(None),
                Subtask.executor_name != "",
            )
            .order_by(Subtask.id.desc())
            .first()
        )

        if not last_assistant_subtask:
            # No executor-based subtasks found, no rebuild needed
            return False

        if last_assistant_subtask.executor_deleted_at:
            # Executor was deleted, mark for rebuild by:
            # 1. Clearing executor_deleted_at flag
            # 2. Clearing executor_name for ALL assistant subtasks so new subtasks
            #    won't inherit the old container name from ANY previous subtask
            # This allows the next message to create a new executor
            logger.info(
                f"Task {task_id} executor was deleted, clearing executor_deleted_at "
                f"and executor_names for new container creation"
            )

            # Reset executor_deleted_at for flagged subtasks
            db.query(Subtask).filter(
                Subtask.task_id == task_id,
                Subtask.executor_deleted_at.is_(True),
            ).update({Subtask.executor_deleted_at: False})

            # Clear executor_name for ALL assistant subtasks with executor_name
            # This prevents the inheritance logic from picking up old container names
            db.query(Subtask).filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.executor_name.isnot(None),
                Subtask.executor_name != "",
            ).update({Subtask.executor_name: ""})

            return True

        return False

    def _mark_workspace_for_restore(self, db: Session, task_id: int) -> bool:
        """
        Mark a code task for workspace restoration.

        If a workspace archive exists for this task, mark it for restoration
        so the new executor can download and restore the workspace files.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            True if workspace was marked for restoration, False otherwise
        """
        if not is_workspace_archive_enabled():
            logger.debug(
                f"Workspace archive not enabled, skipping restore mark for task {task_id}"
            )
            return False

        # Check if task has an archive
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
            )
            .first()
        )

        if not task or not task.workspace_archive_key:
            logger.debug(f"Task {task_id} has no workspace archive")
            return False

        # Mark for restoration
        return workspace_archive_service.mark_for_restore(db, task_id)


# Singleton instance
task_restore_service = TaskRestoreService()
