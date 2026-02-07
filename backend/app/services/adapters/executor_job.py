# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Set, Tuple

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.adapters.workspace_archive import (
    is_workspace_archive_enabled,
    workspace_archive_service,
)
from app.services.base import BaseService

logger = logging.getLogger(__name__)


class JobService(BaseService[Kind, None, None]):
    """
    Job service for background tasks using kinds table
    """

    def _get_executor_address(
        self, executor_name: str, executor_namespace: str
    ) -> Optional[Tuple[str, int]]:
        """
        Get executor container address (host, port) for archive API calls.

        Args:
            executor_name: Name of the executor container
            executor_namespace: Namespace of the executor

        Returns:
            Tuple of (host, port) or None if not available
        """
        try:
            result = executor_kinds_service.get_executor_address_sync(
                executor_name, executor_namespace
            )
            if result and result.get("status") == "success":
                base_url = result.get("base_url", "")
                if base_url:
                    # Parse base_url like "http://localhost:10001"
                    from urllib.parse import urlparse

                    parsed = urlparse(base_url)
                    host = parsed.hostname or "localhost"
                    port = parsed.port or 8080
                    return (host, port)
        except Exception as e:
            logger.warning(f"Failed to get executor address: {e}")
        return None

    def _archive_workspace_before_cleanup(
        self,
        db: Session,
        task_id: int,
        executor_name: str,
        executor_namespace: str,
    ) -> bool:
        """
        Archive workspace before deleting executor.

        Args:
            db: Database session
            task_id: Task ID
            executor_name: Executor container name
            executor_namespace: Executor namespace

        Returns:
            True if archive succeeded or was skipped, False if failed critically
        """
        if not is_workspace_archive_enabled():
            return True  # Feature disabled, skip but don't fail

        try:
            # Get executor address for API call
            address = self._get_executor_address(executor_name, executor_namespace)
            if not address:
                logger.warning(
                    f"[executor_job] Could not get executor address for archiving "
                    f"task {task_id}, skipping workspace archive"
                )
                return True  # Can't archive but don't block cleanup

            host, port = address
            success, error = workspace_archive_service.archive_workspace(
                db=db,
                task_id=task_id,
                executor_name=executor_name,
                executor_host=host,
                executor_port=port,
            )

            if success:
                logger.info(
                    f"[executor_job] Successfully archived workspace for task {task_id}"
                )
            else:
                logger.warning(
                    f"[executor_job] Failed to archive workspace for task {task_id}: {error}"
                )

            return True  # Don't block cleanup even if archive fails

        except Exception as e:
            logger.error(
                f"[executor_job] Exception during workspace archive for task {task_id}: {e}"
            )
            return True  # Don't block cleanup on archive errors

    def cleanup_stale_executors(self, db: Session) -> None:
        """
        Scan subtasks and delete executor tasks if:
        - subtask.status in (COMPLETED, FAILED, CANCELLED)
        - corresponding task.status in (COMPLETED, FAILED, CANCELLED)
        - executor_name and executor_namespace are both non-empty
        - updated_at older than expired hours
        Deduplicate by (executor_namespace, executor_name).
        After successful deletion, set executor_deleted_at.

        For code tasks with workspace archive enabled, archives the workspace
        to S3 before deleting the executor.
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
            # Also collect task info for archiving
            valid_candidates = []
            task_info_map: Dict[int, Tuple[str, str]] = {}  # task_id -> (type, status)

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
                    task_info_map[subtask.task_id] = (task_type, task_status)

            if not valid_candidates:
                logger.info(
                    "[executor_job] No valid expired executor to clean up after task status check"
                )
                return

            # Deduplicate by (namespace, name) and collect task_ids for archiving
            unique_executor_keys: Set[tuple[str, str]] = set()
            executor_to_task: Dict[Tuple[str, str], int] = {}  # (ns, name) -> task_id

            for s in valid_candidates:
                if s.executor_name:
                    key = (s.executor_namespace, s.executor_name)
                    unique_executor_keys.add(key)
                    # Keep the first task_id for this executor
                    if key not in executor_to_task:
                        executor_to_task[key] = s.task_id

            if not unique_executor_keys:
                return

            # Use sync version to avoid event loop issues
            for ns, name in unique_executor_keys:
                try:
                    task_id = executor_to_task.get((ns, name))
                    task_type = (
                        task_info_map.get(task_id, ("chat", ""))[0]
                        if task_id
                        else "chat"
                    )

                    # Archive workspace for code tasks before cleanup
                    if task_id and task_type == "code":
                        self._archive_workspace_before_cleanup(db, task_id, name, ns)

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
