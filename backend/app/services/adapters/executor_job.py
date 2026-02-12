# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Set

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.config import settings
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
                        TaskResource.is_active == True,
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
                        TaskResource.is_active == True,
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

            # Deduplicate by (namespace, name)
            unique_executor_keys: Set[tuple[str, str]] = set()
            for s in valid_candidates:
                if s.executor_name:
                    unique_executor_keys.add((s.executor_namespace, s.executor_name))

            if not unique_executor_keys:
                return

            # Use sync version to avoid event loop issues
            for ns, name in unique_executor_keys:
                try:
                    logger.info(
                        f"[executor_job] Scheduled deleting executor task ns={ns} name={name}"
                    )
                    res = executor_kinds_service.delete_executor_task_sync(name, ns)
                    # Mark all subtasks with this (namespace, name) accordingly
                    db.query(Subtask).filter(
                        Subtask.executor_namespace == ns,
                        Subtask.executor_name == name,
                        Subtask.executor_deleted_at == False,
                    ).update(
                        {
                            Subtask.executor_deleted_at: True,
                        }
                    )
                    db.commit()
                except Exception as e:
                    # Log but continue
                    logger.warning(
                        f"[executor_job] Failed to scheduled delete executor task ns={ns} name={name}: {e}"
                    )
        except Exception as e:
            logger.error(f"[executor_job] cleanup_stale_executors error: {e}")


job_service = JobService(Kind)
