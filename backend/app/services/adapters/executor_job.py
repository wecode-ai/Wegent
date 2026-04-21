# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Tuple

from fastapi import HTTPException
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.base import BaseService

logger = logging.getLogger(__name__)


class JobService(BaseService[Kind, None, None]):
    """
    Job service for background tasks using kinds table
    """

    def cleanup_task_executor(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Dict[str, object]:
        """Manually clean up executor resources for a single task."""
        from app.services.task_member_service import task_member_service

        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(
                status_code=404, detail="Task not found or no permission"
            )

        task = self._get_active_task_resource(db, task_id)
        task_crd = Task.model_validate(task.json)
        task_status = task_crd.status.status if task_crd.status else "PENDING"

        if task_status not in ["COMPLETED", "FAILED", "CANCELLED"]:
            return self._build_cleanup_result(task_id, "task_not_finished")

        if self._preserve_executor_enabled(task_crd):
            return self._build_cleanup_result(task_id, "preserve_executor")

        subtasks = self._get_cleanup_subtasks_for_task(db, task_id)
        if not subtasks:
            return self._build_cleanup_result(task_id, "executor_not_found")

        return self._cleanup_executor_entries(
            db=db,
            task_id=task_id,
            task=task,
            subtasks=subtasks,
        )

    def cleanup_stale_executors(self, db: Session) -> None:
        """
        Scan subtasks and delete executor tasks if:
        - subtask.status in (COMPLETED, FAILED, CANCELLED)
        - corresponding task.status in (COMPLETED, FAILED, CANCELLED)
        - executor_name and executor_namespace are both non-empty
        - updated_at older than expired hours
        Deduplicate by (executor_namespace, executor_name).
        After successful deletion, set executor_deleted_at.
        """
        try:
            cutoff = datetime.now() - timedelta(
                hours=settings.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS
            )
            logging.info(
                "[executor_job] Starting scheduled deletion of expired executors, cutoff: {}".format(
                    cutoff
                )
            )

            # Query candidates using tasks table
            # Join with tasks table to check task status
            candidates: List[Subtask] = (
                db.query(Subtask)
                .join(TaskResource, Subtask.task_id == TaskResource.id)
                .filter(
                    and_(
                        Subtask.status.in_(
                            [
                                SubtaskStatus.COMPLETED,
                                SubtaskStatus.FAILED,
                                SubtaskStatus.CANCELLED,
                            ]
                        ),
                        Subtask.updated_at <= cutoff,
                        TaskResource.kind == "Task",
                        TaskResource.is_active.in_(TaskResource.is_active_query()),
                        Subtask.executor_name.isnot(None),
                        Subtask.executor_name != "",
                        Subtask.executor_deleted_at == False,
                    )
                )
                .all()
            )

            if not candidates:
                logger.info("[executor_job] No expired executor to clean up")
                return

            # Filter candidates by checking task status from JSON
            task_map: Dict[int, TaskResource] = {}
            valid_candidates: List[Subtask] = []
            for subtask in candidates:
                task = task_map.get(subtask.task_id)
                if task is None:
                    task = self._get_active_task_resource(
                        db, subtask.task_id, raise_not_found=False
                    )
                    if task is not None:
                        task_map[subtask.task_id] = task

                if not task:
                    continue

                task_crd = Task.model_validate(task.json)
                task_status = task_crd.status.status if task_crd.status else "PENDING"
                labels = task_crd.metadata.labels or {}
                is_subscription_task = labels.get("type") == "subscription"

                # Check if task has preserveExecutor label set to "true"
                # If so, skip this task's executor from cleanup
                if self._preserve_executor_enabled(task_crd):
                    logger.info(
                        f"[executor_job] Skipping executor cleanup for task {subtask.task_id} "
                        f"ns={subtask.executor_namespace} name={subtask.executor_name} "
                        f"due to preserveExecutor label"
                    )
                    continue

                task_type = self._get_task_type(task_crd)
                if task_type == "code":
                    if (
                        datetime.now() - subtask.updated_at
                    ).total_seconds() < settings.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS * 3600:
                        continue

                if (
                    not is_subscription_task
                    and isinstance(task.updated_at, datetime)
                    and task.updated_at > cutoff
                ):
                    continue

                # Check if task status is in COMPLETED, FAILED, or CANCELLED
                if task_status in ["COMPLETED", "FAILED", "CANCELLED"]:
                    valid_candidates.append(subtask)

            if not valid_candidates:
                logger.info(
                    "[executor_job] No valid expired executor to clean up after task status check"
                )
                return

            task_subtasks: Dict[int, List[Subtask]] = {}
            for subtask in valid_candidates:
                task_subtasks.setdefault(subtask.task_id, []).append(subtask)

            for task_id, subtasks in task_subtasks.items():
                try:
                    task = task_map.get(task_id)
                    if not task:
                        continue

                    self._cleanup_executor_entries(
                        db=db,
                        task_id=task_id,
                        task=task,
                        subtasks=subtasks,
                    )
                except Exception as e:
                    # Log but continue
                    logger.warning(
                        f"[executor_job] Failed to scheduled delete executor task for task {task_id}: {e}"
                    )
        except Exception as e:
            logger.error(f"[executor_job] cleanup_stale_executors error: {e}")

    def _build_cleanup_result(
        self,
        task_id: int,
        reason: str,
        executors: List[Dict[str, str]] | None = None,
    ) -> Dict[str, object]:
        """Build a consistent cleanup result payload."""
        return {
            "task_id": task_id,
            "deleted": reason == "executor_deleted",
            "skipped": reason != "executor_deleted",
            "reason": reason,
            "executors": executors or [],
        }

    def _get_active_task_resource(
        self, db: Session, task_id: int, *, raise_not_found: bool = True
    ) -> TaskResource | None:
        """Load an active task resource by id."""
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.in_(TaskResource.is_active_query()),
            )
            .first()
        )

        if task or not raise_not_found:
            return task

        raise HTTPException(status_code=404, detail="Task not found")

    def _get_cleanup_subtasks_for_task(
        self, db: Session, task_id: int
    ) -> List[Subtask]:
        """Load undeleted executor subtasks for a specific task."""
        return (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.executor_name.isnot(None),
                Subtask.executor_name != "",
                Subtask.executor_deleted_at == False,
            )
            .all()
        )

    def _cleanup_executor_entries(
        self,
        db: Session,
        *,
        task_id: int,
        task: TaskResource,
        subtasks: List[Subtask],
    ) -> Dict[str, object]:
        """Delete deduplicated executors and mark the related subtasks as deleted."""
        executor_subtask_ids: Dict[Tuple[str, str], List[int]] = {}
        executor_subtasks: Dict[Tuple[str, str], Subtask] = {}

        for subtask in subtasks:
            if not subtask.executor_name:
                continue
            key = (subtask.executor_namespace, subtask.executor_name)
            executor_subtask_ids.setdefault(key, []).append(subtask.id)
            executor_subtasks.setdefault(key, subtask)

        if not executor_subtasks:
            return self._build_cleanup_result(task_id, "executor_not_found")

        task_crd = Task.model_validate(task.json)
        task_type = self._get_task_type(task_crd)
        deleted_executors: List[Dict[str, str]] = []

        for (namespace, name), subtask in executor_subtasks.items():
            if task_type == "code":
                try:
                    self._archive_workspace_sync(
                        db=db,
                        subtask=subtask,
                        task=task,
                        executor_name=name,
                        executor_namespace=namespace,
                    )
                except Exception as archive_error:
                    logger.warning(
                        f"[executor_job] Failed to archive workspace for task {task.id} "
                        f"ns={namespace} name={name}: {archive_error}"
                    )

            logger.info(
                f"[executor_job] Scheduled deleting executor task ns={namespace} name={name}"
            )
            executor_kinds_service.delete_executor_task_sync(name, namespace)
            self._mark_executor_deleted(executor_subtask_ids[(namespace, name)])
            db.commit()
            deleted_executors.append(
                {
                    "executor_name": name,
                    "executor_namespace": namespace,
                }
            )

        return self._build_cleanup_result(
            task_id, "executor_deleted", deleted_executors
        )

    def _preserve_executor_enabled(self, task_crd: Task) -> bool:
        """Check whether the task is marked to preserve its executor."""
        return bool(
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("preserveExecutor") == "true"
        )

    def _get_task_type(self, task_crd: Task) -> str:
        """Return the normalized task type label."""
        return (
            task_crd.metadata.labels and task_crd.metadata.labels.get("taskType")
        ) or "chat"

    def _archive_workspace_sync(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        executor_name: str,
        executor_namespace: str,
    ) -> None:
        """Archive workspace files before Pod deletion (synchronous wrapper).

        This method wraps the async archive_service.archive_workspace() for use
        in the synchronous cleanup_stale_executors job.

        Args:
            db: Database session
            subtask: Subtask with executor info
            task: Task resource
            executor_name: Executor name
            executor_namespace: Executor namespace
        """
        from app.services.workspace_archive import archive_service

        logger.info(
            f"[executor_job] Archiving workspace for task {task.id}, "
            f"executor={executor_namespace}/{executor_name}"
        )

        # Run async archive in new event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            archive_info = loop.run_until_complete(
                archive_service.archive_workspace(
                    db=db,
                    subtask=subtask,
                    task=task,
                    executor_name=executor_name,
                    executor_namespace=executor_namespace,
                )
            )

            if archive_info:
                logger.info(
                    f"[executor_job] Workspace archived for task {task.id}, "
                    f"size={archive_info.sizeBytes} bytes"
                )
            else:
                logger.info(
                    f"[executor_job] Workspace archiving skipped or failed for task {task.id}"
                )
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

    def _mark_executor_deleted(self, subtask_ids: List[int]) -> None:
        """Mark selected subtasks as deleted in a short-lived transaction."""
        if not subtask_ids:
            return

        short_db = SessionLocal()
        try:
            short_db.query(Subtask).filter(
                Subtask.id.in_(subtask_ids),
                Subtask.executor_deleted_at == False,
            ).update(
                {
                    Subtask.executor_deleted_at: True,
                }
            )
            short_db.commit()
        except Exception:
            short_db.rollback()
            raise
        finally:
            short_db.close()


job_service = JobService(Kind)
