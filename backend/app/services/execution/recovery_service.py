# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Executor recovery service for Pod recreation after deletion.

When a user sends a message to a task whose executor has been deleted
(executor_deleted_at=True), this service:
1. Recreates the Pod with skip_git_clone=true (to avoid git clone conflict)
2. Restores workspace files from archive (if available)
3. Returns new executor info to caller
4. Caller should update current subtask with new executor info

If archive is not available or expired, the Pod is created normally
with git clone enabled.
"""

import logging
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.services.task_status import mark_task_failed
from app.services.workspace_archive import archive_service
from shared.models import ExecutionRequest

logger = logging.getLogger(__name__)


class ExecutorRecoveryService:
    """Service for recovering executor Pods after deletion.

    This service is called by ExecutionDispatcher when it detects that
    a subtask's executor has been deleted (executor_deleted_at=True).

    Recovery flow:
    1. Check if archive exists and is valid (not expired)
    2. Create Pod with skip_git_clone=true if archive exists
    3. Restore workspace from archive
    4. Return new executor info to caller
    5. Caller updates current subtask with new executor info

    If archive is not available:
    1. Create Pod normally (with git clone)
    2. Return new executor info to caller
    3. Caller updates current subtask with new executor info
    """

    def _resolve_executor_namespace(
        self,
        sandbox: object,
        previous_namespace: Optional[str],
    ) -> str:
        namespace = getattr(sandbox, "executor_namespace", None)
        if isinstance(namespace, str) and namespace.strip():
            return namespace.strip()

        metadata = getattr(sandbox, "metadata", None)
        if isinstance(metadata, dict):
            metadata_namespace = metadata.get("executor_namespace")
            if isinstance(metadata_namespace, str) and metadata_namespace.strip():
                return metadata_namespace.strip()

        if isinstance(previous_namespace, str) and previous_namespace.strip():
            return previous_namespace.strip()

        return "default"

    def _persist_prepare_failure(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        error_message: str,
    ) -> None:
        """Persist executor prepare failures for later inspection and UI display."""
        subtask.error_message = error_message
        subtask.status = SubtaskStatus.FAILED
        subtask.progress = 100
        mark_task_failed(task, error_message)
        db.add(subtask)
        db.add(task)
        db.commit()

    async def recover(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        request: ExecutionRequest,
    ) -> Optional[Dict[str, str]]:
        """Recover executor Pod for a task.

        Args:
            db: Database session
            subtask: Subtask with executor_deleted_at=True (used for workspace restore)
            task: Parent task
            request: Execution request carrying the normal executor config

        Returns:
            Dict with executor_name and executor_namespace if successful,
            None otherwise. Caller should use this info to update current subtask.
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
                result = await self._recover_with_archive(
                    db=db,
                    subtask=subtask,
                    task=task,
                    request=request,
                )
                if result:
                    return {
                        "executor_name": request.executor_name,
                        "executor_namespace": request.executor_namespace,
                    }
                return None
            else:
                logger.info(
                    f"[RecoveryService] No archive for task {task_id}, "
                    "will create Pod with git clone"
                )
                result = await self._recover_without_archive(
                    db=db,
                    subtask=subtask,
                    task=task,
                    request=request,
                )
                if result:
                    return {
                        "executor_name": request.executor_name,
                        "executor_namespace": request.executor_namespace,
                    }
                return None

        except RuntimeError:
            raise
        except Exception as e:
            logger.error(
                f"[RecoveryService] Error recovering task {task_id}: {e}",
                exc_info=True,
            )
            return None

    async def _recover_with_archive(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        request: ExecutionRequest,
    ) -> bool:
        """Recover Pod using workspace archive.

        1. Create Pod with skip_git_clone=true
        2. Restore workspace from archive
        3. Reset executor_deleted_at=False

        Args:
            db: Database session
            subtask: Subtask
            task: Task
            request: Execution request carrying the normal executor config

        Returns:
            True if successful, False otherwise
        """
        task_id = task.id

        try:
            request.skip_git_clone = True
            request.executor_name = None
            request.executor_namespace = None

            executor, error = await self._prepare_executor(request, True)

            if error or not executor:
                logger.error(
                    f"[RecoveryService] Failed to prepare executor for task {task_id}: {error}"
                )
                if error:
                    self._persist_prepare_failure(db, subtask, task, error)
                return False

            executor_name = executor.container_name
            executor_namespace = self._resolve_executor_namespace(
                sandbox=executor,
                previous_namespace=subtask.executor_namespace,
            )

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

            # Set executor info in request for caller to use
            # Note: We do NOT update the subtask here - caller should update
            # the current subtask with this info to preserve history
            request.executor_name = executor_name
            request.executor_namespace = executor_namespace

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
        request: ExecutionRequest,
    ) -> bool:
        """Recover Pod with normal git clone (no archive).

        1. Create Pod normally (git clone will happen)
        2. Reset executor_deleted_at=False

        Args:
            db: Database session
            subtask: Subtask
            task: Task
            request: Execution request carrying the normal executor config

        Returns:
            True if successful, False otherwise
        """
        task_id = task.id

        try:
            request.skip_git_clone = False
            request.executor_name = None
            request.executor_namespace = None

            executor, error = await self._prepare_executor(request, False)

            if error or not executor:
                logger.error(
                    f"[RecoveryService] Failed to prepare executor for task {task_id}: {error}"
                )
                if error:
                    self._persist_prepare_failure(db, subtask, task, error)
                return False

            executor_name = executor.container_name
            executor_namespace = self._resolve_executor_namespace(
                sandbox=executor,
                previous_namespace=subtask.executor_namespace,
            )

            # Set executor info in request for caller to use
            # Note: We do NOT update the subtask here - caller should update
            # the current subtask with this info to preserve history
            request.executor_name = executor_name
            request.executor_namespace = executor_namespace

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

    async def _prepare_executor(
        self,
        request: ExecutionRequest,
        skip_git_clone: bool,
    ):
        """Prepare a normal executor runtime without initial dispatch.

        Args:
            request: Execution request carrying the normal executor config
            skip_git_clone: Whether to skip git clone

        Returns:
            Tuple of (executor runtime, error_message)
        """
        from app.services.execution import get_executor_runtime_client

        runtime_client = get_executor_runtime_client()
        request.skip_git_clone = skip_git_clone
        request.executor_name = None
        request.executor_namespace = None

        executor, error = await runtime_client.prepare_executor(
            request=request,
        )

        return executor, error


# Global service instance
recovery_service = ExecutorRecoveryService()
