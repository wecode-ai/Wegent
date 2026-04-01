# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Executor recovery service for Pod recreation after deletion.

When a user sends a message to a task whose executor has been deleted
(executor_deleted_at=True), this service:
1. Recreates the Pod with skip_git_clone=true (to avoid git clone conflict)
2. Restores workspace files from archive (if available)
3. Resets executor_deleted_at=False
4. Allows execution to proceed normally

If archive is not available or expired, the Pod is created normally
with git clone enabled.
"""

import asyncio
import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.workspace_archive import archive_service

logger = logging.getLogger(__name__)


class ExecutorRecoveryService:
    """Service for recovering executor Pods after deletion.

    This service is called by ExecutionDispatcher when it detects that
    a subtask's executor has been deleted (executor_deleted_at=True).

    Recovery flow:
    1. Check if archive exists and is valid (not expired)
    2. Create Pod with skip_git_clone=true if archive exists
    3. Restore workspace from archive
    4. Reset executor_deleted_at=False
    5. Return success so execution can proceed

    If archive is not available:
    1. Create Pod normally (with git clone)
    2. Reset executor_deleted_at=False
    3. Return success
    """

    async def recover(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        user_id: int,
        user_name: str,
    ) -> bool:
        """Recover executor Pod for a task.

        Args:
            db: Database session
            subtask: Subtask with executor_deleted_at=True
            task: Parent task
            user_id: User ID
            user_name: Username

        Returns:
            True if recovery successful, False otherwise
        """
        task_id = task.id
        logger.info(
            f"[RecoveryService] Starting recovery for task {task_id}, "
            f"subtask {subtask.id}"
        )

        try:
            # Check if archive is available
            archive_available, storage_key, reason = (
                archive_service.check_archive_available(task)
            )

            # Archive exists but expired - reject task execution
            if reason == "expired":
                logger.warning(
                    f"[RecoveryService] Archive expired for task {task_id}, "
                    "rejecting task execution"
                )
                raise RuntimeError(
                    f"Workspace archive for task {task_id} has expired (>30 days). "
                    "This task can no longer be resumed. "
                    "Please create a new task to continue."
                )

            if archive_available:
                logger.info(
                    f"[RecoveryService] Archive found for task {task_id}, "
                    f"will restore from archive"
                )
                return await self._recover_with_archive(
                    db=db,
                    subtask=subtask,
                    task=task,
                    user_id=user_id,
                    user_name=user_name,
                )
            else:
                logger.info(
                    f"[RecoveryService] No archive for task {task_id}, "
                    "will create Pod with git clone"
                )
                return await self._recover_without_archive(
                    db=db,
                    subtask=subtask,
                    task=task,
                    user_id=user_id,
                    user_name=user_name,
                )

        except RuntimeError:
            raise
        except Exception as e:
            logger.error(
                f"[RecoveryService] Error recovering task {task_id}: {e}",
                exc_info=True,
            )
            return False

    async def _recover_with_archive(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        user_id: int,
        user_name: str,
    ) -> bool:
        """Recover Pod using workspace archive.

        1. Create Pod with skip_git_clone=true
        2. Restore workspace from archive
        3. Reset executor_deleted_at=False

        Args:
            db: Database session
            subtask: Subtask
            task: Task
            user_id: User ID
            user_name: Username

        Returns:
            True if successful, False otherwise
        """
        task_id = task.id

        try:
            # Create Pod with skip_git_clone=true
            sandbox, error = await self._create_sandbox(
                task=task,
                subtask=subtask,
                user_id=user_id,
                user_name=user_name,
                skip_git_clone=True,
            )

            if error or not sandbox:
                logger.error(
                    f"[RecoveryService] Failed to create sandbox for task {task_id}: {error}"
                )
                return False

            executor_name = sandbox.container_name
            executor_namespace = "default"

            # Restore workspace from archive
            restore_success = await archive_service.restore_workspace(
                db=db,
                task=task,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )

            if not restore_success:
                logger.warning(
                    f"[RecoveryService] Failed to restore workspace for task {task_id}, "
                    "continuing with empty workspace"
                )

            # Update subtask with new executor info and reset deleted flag
            subtask.executor_name = executor_name
            subtask.executor_namespace = executor_namespace
            subtask.executor_deleted_at = False
            db.add(subtask)
            db.commit()

            logger.info(
                f"[RecoveryService] Successfully recovered task {task_id} with archive, "
                f"executor={executor_namespace}/{executor_name}"
            )

            return True

        except Exception as e:
            logger.error(
                f"[RecoveryService] Error recovering with archive for task {task_id}: {e}",
                exc_info=True,
            )
            return False

    async def _recover_without_archive(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        user_id: int,
        user_name: str,
    ) -> bool:
        """Recover Pod with normal git clone (no archive).

        1. Create Pod normally (git clone will happen)
        2. Reset executor_deleted_at=False

        Args:
            db: Database session
            subtask: Subtask
            task: Task
            user_id: User ID
            user_name: Username

        Returns:
            True if successful, False otherwise
        """
        task_id = task.id

        try:
            # Create Pod normally
            sandbox, error = await self._create_sandbox(
                task=task,
                subtask=subtask,
                user_id=user_id,
                user_name=user_name,
                skip_git_clone=False,
            )

            if error or not sandbox:
                logger.error(
                    f"[RecoveryService] Failed to create sandbox for task {task_id}: {error}"
                )
                return False

            executor_name = sandbox.container_name
            executor_namespace = "default"

            # Update subtask with new executor info and reset deleted flag
            subtask.executor_name = executor_name
            subtask.executor_namespace = executor_namespace
            subtask.executor_deleted_at = False
            db.add(subtask)
            db.commit()

            logger.info(
                f"[RecoveryService] Successfully recovered task {task_id} without archive, "
                f"executor={executor_namespace}/{executor_name}"
            )

            return True

        except Exception as e:
            logger.error(
                f"[RecoveryService] Error recovering without archive for task {task_id}: {e}",
                exc_info=True,
            )
            return False

    async def _create_sandbox(
        self,
        task: TaskResource,
        subtask: Subtask,
        user_id: int,
        user_name: str,
        skip_git_clone: bool,
    ):
        """Create a new sandbox Pod for the task.

        Args:
            task: Task resource
            subtask: Subtask
            user_id: User ID
            user_name: Username
            skip_git_clone: Whether to skip git clone

        Returns:
            Tuple of (Sandbox, error_message)
        """
        from app.services.execution import get_sandbox_manager

        task_crd = Task.model_validate(task.json)

        # Get shell type from subtask or task
        shell_type = "ClaudeCode"  # Default

        # Build bot_config from task
        bot_config = {}

        # Build metadata
        metadata = {
            "task_id": task.id,
            "subtask_id": subtask.id,
            "skip_git_clone": skip_git_clone,
        }

        # Get workspace ref if available
        workspace_ref = (
            task_crd.spec.workspaceRef.name if task_crd.spec.workspaceRef else None
        )

        # Create sandbox
        sandbox_manager = get_sandbox_manager()
        sandbox, error = await sandbox_manager.create_sandbox(
            shell_type=shell_type,
            user_id=user_id,
            user_name=user_name,
            workspace_ref=workspace_ref,
            bot_config=bot_config,
            metadata=metadata,
        )

        return sandbox, error


# Global service instance
recovery_service = ExecutorRecoveryService()
