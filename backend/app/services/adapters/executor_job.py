# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Set, Tuple

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
                        TaskResource.is_active == TaskResource.STATE_ACTIVE,
                        TaskResource.updated_at <= cutoff,
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
            valid_candidates = []
            for subtask in candidates:
                # Get task from tasks table
                task = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == subtask.task_id,
                        TaskResource.kind == "Task",
                        TaskResource.is_active == TaskResource.STATE_ACTIVE,
                    )
                    .first()
                )

                if not task:
                    continue

                task_crd = Task.model_validate(task.json)
                task_status = task_crd.status.status if task_crd.status else "PENDING"

                # Check if task has preserveExecutor label set to "true"
                # If so, skip this task's executor from cleanup
                preserve_executor = (
                    task_crd.metadata.labels
                    and task_crd.metadata.labels.get("preserveExecutor") == "true"
                )
                if preserve_executor:
                    logger.info(
                        f"[executor_job] Skipping executor cleanup for task {subtask.task_id} "
                        f"ns={subtask.executor_namespace} name={subtask.executor_name} "
                        f"due to preserveExecutor label"
                    )
                    continue

                task_type = (
                    task_crd.metadata.labels
                    and task_crd.metadata.labels.get("taskType")
                    or "chat"
                )
                if task_type == "code":
                    if (
                        datetime.now() - subtask.updated_at
                    ).total_seconds() < settings.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS * 3600:
                        continue

                # Check if task status is in COMPLETED, FAILED, or CANCELLED
                if task_status in ["COMPLETED", "FAILED", "CANCELLED"]:
                    valid_candidates.append(subtask)

            if not valid_candidates:
                logger.info(
                    "[executor_job] No valid expired executor to clean up after task status check"
                )
                return

            # Deduplicate by (namespace, name) and collect task info for archiving.
            # Keep the matched subtask ids so the final update can target primary keys
            # instead of scanning by executor fields again.
            executor_task_map: Dict[Tuple[str, str], Tuple[Subtask, TaskResource]] = {}
            executor_subtask_ids: Dict[Tuple[str, str], List[int]] = {}
            for subtask in valid_candidates:
                if subtask.executor_name:
                    key = (subtask.executor_namespace, subtask.executor_name)
                    executor_subtask_ids.setdefault(key, []).append(subtask.id)
                    if key not in executor_task_map:
                        # Get task for this subtask
                        task = (
                            db.query(TaskResource)
                            .filter(
                                TaskResource.id == subtask.task_id,
                                TaskResource.kind == "Task",
                                TaskResource.is_active == TaskResource.STATE_ACTIVE,
                            )
                            .first()
                        )
                        if task:
                            executor_task_map[key] = (subtask, task)

            if not executor_task_map:
                return

            # Use sync version to avoid event loop issues
            for (ns, name), (subtask, task) in executor_task_map.items():
                try:
                    # Archive workspace before deletion (for code tasks)
                    task_crd = Task.model_validate(task.json)
                    task_type = (
                        task_crd.metadata.labels
                        and task_crd.metadata.labels.get("taskType")
                        or "chat"
                    )

                    if task_type == "code":
                        # Try to archive workspace before deletion
                        try:
                            self._archive_workspace_sync(
                                db=db,
                                subtask=subtask,
                                task=task,
                                executor_name=name,
                                executor_namespace=ns,
                            )
                        except Exception as archive_error:
                            # Log but continue with deletion
                            # Recovery will fall back to git clone if archive failed
                            logger.warning(
                                f"[executor_job] Failed to archive workspace for task {task.id} "
                                f"ns={ns} name={name}: {archive_error}"
                            )

                    logger.info(
                        f"[executor_job] Scheduled deleting executor task ns={ns} name={name}"
                    )
                    res = executor_kinds_service.delete_executor_task_sync(name, ns)
                    self._mark_executor_deleted(
                        executor_subtask_ids.get((ns, name), [])
                    )
                    db.commit()
                except Exception as e:
                    # Log but continue
                    logger.warning(
                        f"[executor_job] Failed to scheduled delete executor task ns={ns} name={name}: {e}"
                    )
        except Exception as e:
            logger.error(f"[executor_job] cleanup_stale_executors error: {e}")

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
