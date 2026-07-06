# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Tuple

from fastapi import HTTPException
from sqlalchemy import inspect as sqlalchemy_inspect
from sqlalchemy.ext.asyncio import AsyncSession

import app.stores.tasks as task_stores
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.base import BaseService
from app.services.executor_cleanup_cursor_service import (
    executor_cleanup_cursor_service,
)

logger = logging.getLogger(__name__)

CLEANUP_TARGET_DELETED_EXECUTORS_PER_RUN = 2000
CLEANUP_MAX_BATCHES_PER_RUN = 50


@dataclass
class CleanupFilterStats:
    missing_task: int = 0
    invalid_task_payload: int = 0
    non_terminal_task: int = 0
    stale_non_terminal_task: int = 0
    preserve_executor: int = 0
    code_task_recent: int = 0
    task_updated_recent: int = 0


class JobService(BaseService[Kind, None, None]):
    """
    Job service for background tasks using kinds table
    """

    async def cleanup_task_executor(
        self, db: AsyncSession, *, task_id: int, user_id: int
    ) -> Dict[str, object]:
        """Manually clean up executor resources for a single task."""
        from app.services.task_member_service import task_member_service

        # is_member uses sync ORM API, bridge via run_sync
        is_member = await db.run_sync(
            lambda sync_session: task_member_service.is_member(
                sync_session, task_id, user_id
            )
        )
        if not is_member:
            raise HTTPException(
                status_code=404, detail="Task not found or no permission"
            )

        task = await self._get_active_task_resource(db, task_id)
        task_crd = Task.model_validate(task.json)
        task_status = task_crd.status.status if task_crd.status else "PENDING"

        if task_status not in ["COMPLETED", "FAILED", "CANCELLED"]:
            return self._build_cleanup_result(task_id, "task_not_finished")

        if self._preserve_executor_enabled(task_crd):
            return self._build_cleanup_result(task_id, "preserve_executor")

        subtasks = await self._get_cleanup_subtasks_for_task(db, task_id)
        if not subtasks:
            return self._build_cleanup_result(task_id, "executor_not_found")

        return await self._cleanup_executor_entries(
            db=db,
            task_id=task_id,
            task=task,
            subtasks=subtasks,
        )

    async def cleanup_stale_task_executors(
        self,
        db: AsyncSession,
        *,
        inactive_hours: int = 24,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """Clean up task executor Pods that have been inactive long enough."""
        now = datetime.now()
        cutoff = now - timedelta(hours=inactive_hours)
        subtasks = await self._list_runtime_cleanup_subtasks(db)
        task_ids = sorted({subtask.task_id for subtask in subtasks})
        task_map = await self._load_tasks_for_cleanup(db, task_ids=task_ids)

        result: Dict[str, Any] = {
            "target": "task_executors",
            "inactive_hours": inactive_hours,
            "dry_run": dry_run,
            "deleted": [],
            "skipped": [],
            "failed": [],
        }

        executor_groups: Dict[Tuple[str, str], List[Subtask]] = {}
        for subtask in subtasks:
            if not subtask.executor_name:
                continue
            key = (subtask.executor_namespace or "", subtask.executor_name)
            executor_groups.setdefault(key, []).append(subtask)

        for task in task_map.values():
            self._detach_loaded_instance(db, task)
        for subtask in subtasks:
            self._detach_loaded_instance(db, subtask)
        await self._release_cleanup_read_transaction(db)

        for (namespace, name), group_subtasks in executor_groups.items():
            task_id = group_subtasks[0].task_id
            subtask_ids = [subtask.id for subtask in group_subtasks]

            skip_reason = self._get_runtime_cleanup_skip_reason(
                task_map=task_map,
                subtasks=group_subtasks,
                cutoff=cutoff,
                inactive_hours=inactive_hours,
            )
            if skip_reason:
                result["skipped"].append(
                    {
                        "task_id": task_id,
                        "executor_name": name,
                        "executor_namespace": namespace,
                        **skip_reason,
                    }
                )
                continue

            if dry_run:
                result["skipped"].append(
                    {
                        "task_id": task_id,
                        "executor_name": name,
                        "executor_namespace": namespace,
                        "reason": "dry_run",
                    }
                )
                continue

            try:
                archive_task = self._get_code_archive_task(
                    task_map=task_map,
                    subtasks=group_subtasks,
                )
                if archive_task and not await self._archive_workspace(
                    task=archive_task,
                    executor_name=name,
                    executor_namespace=namespace,
                ):
                    result["skipped"].append(
                        {
                            "task_id": task_id,
                            "executor_name": name,
                            "executor_namespace": namespace,
                            "reason": "archive_failed",
                        }
                    )
                    continue
                await executor_kinds_service.delete_executor_task_async(name, namespace)
                await self._mark_executor_deleted(subtask_ids)
                result["deleted"].append(
                    {
                        "task_id": task_id,
                        "executor_name": name,
                        "executor_namespace": namespace,
                    }
                )
            except Exception as exc:
                result["failed"].append(
                    {
                        "task_id": task_id,
                        "executor_name": name,
                        "executor_namespace": namespace,
                        "reason": "delete_failed",
                        "error": str(exc),
                    }
                )

        return result

    async def cleanup_stale_task_executor(
        self,
        db: AsyncSession,
        *,
        task_id: int,
        inactive_hours: int = 24,
        dry_run: bool = False,
    ) -> Dict[str, object]:
        """Clean up executor resources for a single task after the stale window.

        The inactive_hours parameter is the sole eligibility gate. Task status is
        intentionally not checked here — a pod stuck in RUNNING with no activity for
        24h is just as stale as a COMPLETED one, and the admin explicitly requested
        cleanup with the inactivity threshold.
        """
        task = await self._get_task_resource_any_state(db, task_id)

        subtasks = await self._get_cleanup_subtasks_for_task(db, task_id)
        if not subtasks:
            return self._build_cleanup_result(
                task_id,
                "executor_not_found",
                details={"inactive_hours": inactive_hours, "dry_run": dry_run},
            )

        cutoff = datetime.now() - timedelta(hours=inactive_hours)
        skip_reason = self._get_runtime_cleanup_skip_reason(
            task_map={task_id: task},
            subtasks=subtasks,
            cutoff=cutoff,
            inactive_hours=inactive_hours,
        )
        if skip_reason:
            return self._build_cleanup_result(
                task_id,
                skip_reason["reason"],
                details={
                    "inactive_hours": inactive_hours,
                    "dry_run": dry_run,
                    **skip_reason,
                },
            )

        executors = self._build_executor_result_items(subtasks)
        if dry_run:
            return self._build_cleanup_result(
                task_id,
                "dry_run",
                executors=executors,
                details={"inactive_hours": inactive_hours, "dry_run": True},
            )

        result = await self._cleanup_executor_entries(
            db=db,
            task_id=task_id,
            task=task,
            subtasks=subtasks,
        )
        result["inactive_hours"] = inactive_hours
        result["dry_run"] = dry_run
        return result

    async def cleanup_stale_executors(self, db: AsyncSession) -> None:
        """
        Scan subtasks and delete executor tasks if:
        - subtask.status in (PENDING, COMPLETED, FAILED, CANCELLED)
        - corresponding task.status in (PENDING, COMPLETED, FAILED, CANCELLED)
        - executor_name and executor_namespace are both non-empty
        - updated_at older than expired hours
        Deduplicate by (executor_namespace, executor_name).
        After successful deletion, set executor_deleted_at.
        """
        try:
            now = datetime.now()
            cutoff = now - timedelta(
                hours=settings.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS
            )
            lookback_start = now - timedelta(hours=self._get_lookback_hours())
            logger.info(
                "[executor_job] Starting scheduled deletion of expired executors, cutoff: %s",
                cutoff,
            )
            cursor = await executor_cleanup_cursor_service.get_cursor(db)
            last_id = cursor.last_scanned_subtask_id
            total_scanned = 0
            total_valid = 0
            total_deleted = 0
            total_filter_stats = CleanupFilterStats()
            scanned_batches = 0

            while (
                scanned_batches < CLEANUP_MAX_BATCHES_PER_RUN
                and total_deleted < CLEANUP_TARGET_DELETED_EXECUTORS_PER_RUN
            ):
                scanned_subtasks = await self._scan_candidate_subtasks_batch(
                    db=db,
                    last_id=last_id,
                    cutoff=cutoff,
                    batch_size=self._get_primary_scan_batch_size(),
                )
                if not scanned_subtasks:
                    break

                scanned_batches += 1
                total_scanned += len(scanned_subtasks)
                last_id = scanned_subtasks[-1].id
                await executor_cleanup_cursor_service.advance_cursor(
                    db,
                    last_scanned_subtask_id=last_id,
                )
                batch_candidates = self._filter_scanned_subtasks(
                    scanned_subtasks,
                    chat_cutoff=cutoff,
                )
                (
                    batch_valid_count,
                    batch_deleted_count,
                    batch_filter_stats,
                ) = await self._process_cleanup_batch(
                    db=db,
                    candidates=batch_candidates,
                    chat_cutoff=cutoff,
                )
                total_valid += batch_valid_count
                total_filter_stats = self._merge_cleanup_filter_stats(
                    total_filter_stats, batch_filter_stats
                )
                total_deleted += batch_deleted_count

            if total_deleted < CLEANUP_TARGET_DELETED_EXECUTORS_PER_RUN:
                logger.info(
                    "[executor_job] Starting lookback scan "
                    "lookback_by=created_at lookback_start=%s cutoff=%s limit=%d",
                    lookback_start,
                    cutoff,
                    self._get_lookback_scan_limit(),
                )
                lookback_subtasks = await self._scan_lookback_subtasks_batch(
                    db=db,
                    lookback_start=lookback_start,
                    cutoff=cutoff,
                    limit=self._get_lookback_scan_limit(),
                )
                total_scanned += len(lookback_subtasks)
                lookback_candidates = self._filter_scanned_subtasks(
                    lookback_subtasks,
                    chat_cutoff=cutoff,
                )
                (
                    lookback_valid_count,
                    lookback_deleted_count,
                    lookback_filter_stats,
                ) = await self._process_cleanup_batch(
                    db=db,
                    candidates=lookback_candidates,
                    chat_cutoff=cutoff,
                )
                total_valid += lookback_valid_count
                total_deleted += lookback_deleted_count
                total_filter_stats = self._merge_cleanup_filter_stats(
                    total_filter_stats, lookback_filter_stats
                )

            if total_scanned == 0:
                logger.info("[executor_job] No expired executor to clean up")
                return

            if total_valid == 0:
                logger.info(
                    "[executor_job] No valid expired executor to clean up after task "
                    "status check scanned=%d last_id=%d missing_task=%d "
                    "invalid_task_payload=%d non_terminal_task=%d "
                    "stale_non_terminal_task=%d "
                    "preserve_executor=%d code_task_recent=%d task_updated_recent=%d",
                    total_scanned,
                    last_id,
                    total_filter_stats.missing_task,
                    total_filter_stats.invalid_task_payload,
                    total_filter_stats.non_terminal_task,
                    total_filter_stats.stale_non_terminal_task,
                    total_filter_stats.preserve_executor,
                    total_filter_stats.code_task_recent,
                    total_filter_stats.task_updated_recent,
                )
                return

            logger.info(
                "[executor_job] cleanup scan finished scanned=%d valid=%d deleted=%d "
                "last_id=%d missing_task=%d invalid_task_payload=%d "
                "non_terminal_task=%d stale_non_terminal_task=%d "
                "preserve_executor=%d code_task_recent=%d task_updated_recent=%d",
                total_scanned,
                total_valid,
                total_deleted,
                last_id,
                total_filter_stats.missing_task,
                total_filter_stats.invalid_task_payload,
                total_filter_stats.non_terminal_task,
                total_filter_stats.stale_non_terminal_task,
                total_filter_stats.preserve_executor,
                total_filter_stats.code_task_recent,
                total_filter_stats.task_updated_recent,
            )
        except Exception as e:
            logger.error(f"[executor_job] cleanup_stale_executors error: {e}")

    async def _list_runtime_cleanup_subtasks(self, db: AsyncSession) -> List[Subtask]:
        """List executor-backed subtasks that have not already been cleaned up."""
        return await db.run_sync(
            lambda sync_db: task_stores.subtask_store.list_runtime_cleanup_subtasks(
                sync_db
            )
        )

    def _get_runtime_cleanup_skip_reason(
        self,
        *,
        task_map: Dict[int, TaskResource],
        subtasks: List[Subtask],
        cutoff: datetime,
        inactive_hours: int,
    ) -> Dict[str, Any] | None:
        """Return why an executor group cannot be deleted, or None if eligible."""
        executor_name = subtasks[0].executor_name
        if self._is_device_executor_name(executor_name):
            return {"reason": "device_executor"}

        latest_update: datetime | None = None
        for subtask in subtasks:
            task = task_map.get(subtask.task_id)
            if not task:
                return {"reason": "task_not_found"}

            try:
                task_crd = Task.model_validate(task.json)
            except Exception as exc:
                return {"reason": "invalid_task_payload", "error": str(exc)}

            if self._preserve_executor_enabled(task_crd):
                return {"reason": "preserve_executor"}

            latest_update = self._latest_datetime(
                latest_update,
                subtask.updated_at,
                task.updated_at,
            )

        if latest_update and latest_update > cutoff:
            eligible_after = latest_update + timedelta(hours=inactive_hours)
            return {
                "reason": "not_stale",
                "last_updated_at": latest_update.isoformat(),
                "eligible_after": eligible_after.isoformat(),
            }

        return None

    def _latest_datetime(self, *values: datetime | None) -> datetime | None:
        """Return the latest datetime from nullable values."""
        datetimes = [value for value in values if isinstance(value, datetime)]
        if not datetimes:
            return None
        return max(datetimes)

    def _get_code_archive_task(
        self,
        *,
        task_map: Dict[int, TaskResource],
        subtasks: List[Subtask],
    ) -> TaskResource | None:
        """Return the code task that needs archive before releasing the session."""
        for subtask in subtasks:
            task = task_map.get(subtask.task_id)
            if not task:
                continue
            task_crd = Task.model_validate(task.json)
            if self._get_task_type(task_crd) == "code":
                return task
        return None

    def _detach_loaded_instance(self, db: AsyncSession, instance: object) -> None:
        """Detach an already-loaded ORM instance before rollback expires it."""
        state = sqlalchemy_inspect(instance, raiseerr=False)
        if state is None or not state.persistent:
            return
        db.sync_session.expunge(instance)

    async def _scan_candidate_subtasks_batch(
        self,
        db: AsyncSession,
        *,
        last_id: int,
        cutoff: datetime,
        batch_size: int,
    ) -> List[Subtask]:
        """Load one ordered primary scan batch using the subtask id cursor.

        Only scans subtasks created before cutoff to avoid advancing the cursor
        past subtasks that are too recent to be eligible for cleanup.
        """
        return await db.run_sync(
            lambda sync_db: task_stores.subtask_store.scan_cleanup_candidate_subtasks(
                sync_db,
                last_id=last_id,
                cutoff=cutoff,
                limit=batch_size,
            )
        )

    async def _scan_lookback_subtasks_batch(
        self,
        db: AsyncSession,
        *,
        lookback_start: datetime,
        cutoff: datetime,
        limit: int,
    ) -> List[Subtask]:
        """Load a bounded created_at window for rows that may have become eligible."""
        return await db.run_sync(
            lambda sync_db: task_stores.subtask_store.scan_cleanup_lookback_subtasks(
                sync_db,
                lookback_start=lookback_start,
                cutoff=cutoff,
                limit=limit,
            )
        )

    def _filter_scanned_subtasks(
        self, scanned_subtasks: List[Subtask], *, chat_cutoff: datetime
    ) -> List[Subtask]:
        """Filter raw scanned subtasks down to cleanup-eligible subtask candidates."""
        return [
            subtask
            for subtask in scanned_subtasks
            if subtask.status
            in [
                SubtaskStatus.PENDING,
                SubtaskStatus.COMPLETED,
                SubtaskStatus.FAILED,
                SubtaskStatus.CANCELLED,
            ]
            and isinstance(subtask.updated_at, datetime)
            and subtask.updated_at <= chat_cutoff
            and bool(subtask.executor_name)
            and not self._is_device_executor_name(subtask.executor_name)
            and not bool(subtask.executor_deleted_at)
        ]

    async def _load_tasks_for_cleanup(
        self, db: AsyncSession, *, task_ids: List[int]
    ) -> Dict[int, TaskResource]:
        """Load active task resources for the provided task ids."""
        if not task_ids:
            return {}

        tasks = await db.run_sync(
            lambda sync_db: task_stores.task_store.list_by_ids(
                sync_db,
                task_ids=task_ids,
            )
        )
        active_states = set(TaskResource.is_active_query())
        return {
            task.id: task
            for task in tasks
            if task.kind == "Task" and task.is_active in active_states
        }

    def _filter_cleanup_candidates(
        self,
        *,
        candidates: List[Subtask],
        task_map: Dict[int, TaskResource],
        chat_cutoff: datetime,
    ) -> Tuple[List[Subtask], CleanupFilterStats]:
        """Apply task-level cleanup rules to a scanned subtask batch."""
        valid_candidates: List[Subtask] = []
        filter_stats = CleanupFilterStats()
        code_cutoff = datetime.now() - timedelta(
            hours=settings.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS
        )
        stale_non_terminal_hours = (
            settings.STALE_NON_TERMINAL_TASK_EXECUTOR_DELETE_AFTER_HOURS
        )
        if not isinstance(stale_non_terminal_hours, (int, float)):
            stale_non_terminal_hours = 24
        stale_non_terminal_cutoff = datetime.now() - timedelta(
            hours=stale_non_terminal_hours
        )

        for subtask in candidates:
            task = task_map.get(subtask.task_id)
            if not task:
                filter_stats.missing_task += 1
                continue

            try:
                task_crd = Task.model_validate(task.json)
            except Exception as exc:
                filter_stats.invalid_task_payload += 1
                logger.warning(
                    "[executor_job] Skipping invalid task payload task_id=%s subtask_id=%s error=%s",
                    subtask.task_id,
                    subtask.id,
                    exc,
                )
                continue

            task_status = task_crd.status.status if task_crd.status else "PENDING"
            if task_status not in ["PENDING", "COMPLETED", "FAILED", "CANCELLED"]:
                if (
                    isinstance(task.updated_at, datetime)
                    and task.updated_at <= stale_non_terminal_cutoff
                ):
                    filter_stats.stale_non_terminal_task += 1
                else:
                    filter_stats.non_terminal_task += 1
                    continue

            labels = task_crd.metadata.labels or {}
            is_subscription_task = labels.get("type") == "subscription"

            if self._preserve_executor_enabled(task_crd):
                filter_stats.preserve_executor += 1
                logger.info(
                    f"[executor_job] Skipping executor cleanup "
                    f"task_id={subtask.task_id} "
                    f"ns={subtask.executor_namespace} name={subtask.executor_name} "
                    f"due to preserveExecutor label"
                )
                continue

            task_type = self._get_task_type(task_crd)
            if task_type == "code" and subtask.updated_at > code_cutoff:
                filter_stats.code_task_recent += 1
                continue

            if (
                not is_subscription_task
                and isinstance(task.updated_at, datetime)
                and task.updated_at > chat_cutoff
            ):
                filter_stats.task_updated_recent += 1
                continue

            valid_candidates.append(subtask)

        return valid_candidates, filter_stats

    def _merge_cleanup_filter_stats(
        self,
        base_stats: CleanupFilterStats,
        batch_stats: CleanupFilterStats,
    ) -> CleanupFilterStats:
        """Aggregate filter reason counters across cleanup batches."""
        return CleanupFilterStats(
            missing_task=base_stats.missing_task + batch_stats.missing_task,
            invalid_task_payload=(
                base_stats.invalid_task_payload + batch_stats.invalid_task_payload
            ),
            non_terminal_task=(
                base_stats.non_terminal_task + batch_stats.non_terminal_task
            ),
            stale_non_terminal_task=(
                base_stats.stale_non_terminal_task + batch_stats.stale_non_terminal_task
            ),
            preserve_executor=(
                base_stats.preserve_executor + batch_stats.preserve_executor
            ),
            code_task_recent=(
                base_stats.code_task_recent + batch_stats.code_task_recent
            ),
            task_updated_recent=(
                base_stats.task_updated_recent + batch_stats.task_updated_recent
            ),
        )

    async def _process_cleanup_batch(
        self, db: AsyncSession, *, candidates: List[Subtask], chat_cutoff: datetime
    ) -> Tuple[int, int, CleanupFilterStats]:
        """Run task-level filtering and executor deletion for one candidate batch."""
        if not candidates:
            return 0, 0, CleanupFilterStats()

        task_map = await self._load_tasks_for_cleanup(
            db=db,
            task_ids=list({subtask.task_id for subtask in candidates}),
        )
        valid_candidates, batch_filter_stats = self._filter_cleanup_candidates(
            candidates=candidates,
            task_map=task_map,
            chat_cutoff=chat_cutoff,
        )
        deleted_count = await self._cleanup_executor_groups(
            db=db,
            valid_candidates=valid_candidates,
            task_map=task_map,
        )
        return len(valid_candidates), deleted_count, batch_filter_stats

    async def _cleanup_executor_groups(
        self,
        db: AsyncSession,
        *,
        valid_candidates: List[Subtask],
        task_map: Dict[int, TaskResource],
    ) -> int:
        """Delete executor groups for valid task candidates and return deleted count."""
        if not valid_candidates:
            return 0

        task_ids = {subtask.task_id for subtask in valid_candidates}
        deleted_count = 0

        for task in task_map.values():
            self._detach_loaded_instance(db, task)

        for task_id in task_ids:
            task = task_map.get(task_id)
            if not task:
                continue

            subtasks = await self._get_cleanup_subtasks_for_task(db, task_id)
            if not subtasks:
                continue

            try:
                result = await self._cleanup_executor_entries(
                    db=db,
                    task_id=task_id,
                    task=task,
                    subtasks=subtasks,
                )
                deleted_count += len(result.get("executors", []))
            except Exception as e:
                logger.warning(
                    f"[executor_job] Failed to scheduled delete executor task "
                    f"task_id={task_id}: {e}"
                )

        return deleted_count

    def _build_cleanup_result(
        self,
        task_id: int,
        reason: str,
        executors: List[Dict[str, str]] | None = None,
        details: Dict[str, Any] | None = None,
    ) -> Dict[str, object]:
        """Build a consistent cleanup result payload."""
        result = {
            "task_id": task_id,
            "deleted": reason == "executor_deleted",
            "skipped": reason != "executor_deleted",
            "reason": reason,
            "executors": executors or [],
        }
        if details:
            result.update(details)
        return result

    def _build_executor_result_items(
        self, subtasks: List[Subtask]
    ) -> List[Dict[str, str]]:
        """Return deduplicated non-device executor identifiers for responses."""
        executors: Dict[Tuple[str, str], Dict[str, str]] = {}
        for subtask in subtasks:
            name = subtask.executor_name
            if not name or self._is_device_executor_name(name):
                continue
            namespace = subtask.executor_namespace or ""
            executors[(namespace, name)] = {
                "executor_name": name,
                "executor_namespace": namespace,
            }
        return list(executors.values())

    async def _get_active_task_resource(
        self, db: AsyncSession, task_id: int, *, raise_not_found: bool = True
    ) -> TaskResource | None:
        """Load an active task resource by id."""
        task = await db.run_sync(
            lambda sync_db: task_stores.task_store.get_active_task(
                sync_db,
                task_id=task_id,
            )
        )

        if task or not raise_not_found:
            return task

        raise HTTPException(status_code=404, detail="Task not found")

    async def _get_task_resource_any_state(
        self, db: AsyncSession, task_id: int
    ) -> TaskResource:
        """Load a task resource by id regardless of its is_active state."""
        task = await db.run_sync(
            lambda sync_db: task_stores.task_store.get_by_id(
                sync_db,
                task_id=task_id,
            )
        )
        if not task or task.kind != "Task":
            raise HTTPException(status_code=404, detail="Task not found")
        return task

    async def _get_cleanup_subtasks_for_task(
        self, db: AsyncSession, task_id: int
    ) -> List[Subtask]:
        """Load undeleted executor subtasks for a specific task."""
        return await db.run_sync(
            lambda sync_db: task_stores.subtask_store.list_cleanup_subtasks_for_task(
                sync_db,
                task_id=task_id,
            )
        )

    async def _cleanup_executor_entries(
        self,
        db: AsyncSession,
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
        self._detach_loaded_instance(db, task)
        await self._release_cleanup_read_transaction(db)

        deleted_executors: List[Dict[str, str]] = []

        for (namespace, name), subtask in executor_subtasks.items():
            if self._is_device_executor_name(name):
                logger.info(
                    "[executor_job] Skipping device executor cleanup "
                    f"task_id={task.id} ns={namespace} name={name}"
                )
                continue

            if task_type == "code" and not await self._archive_workspace(
                task=task,
                executor_name=name,
                executor_namespace=namespace,
            ):
                logger.warning(
                    f"[executor_job] Skipping executor deletion after archive "
                    f"failure task_id={task.id} ns={namespace} name={name}"
                )
                continue

            logger.info(
                f"[executor_job] Scheduled deleting executor task "
                f"task_id={task.id} ns={namespace} name={name}"
            )
            try:
                await executor_kinds_service.delete_executor_task_async(name, namespace)
            except HTTPException as delete_error:
                if not self._is_missing_executor_error(delete_error):
                    raise

                logger.info(
                    "[executor_job] Executor already missing, marking deleted "
                    f"task_id={task.id} ns={namespace} name={name} "
                    f"detail={delete_error.detail}"
                )
            await self._mark_executor_deleted(executor_subtask_ids[(namespace, name)])
            await db.commit()
            deleted_executors.append(
                {
                    "executor_name": name,
                    "executor_namespace": namespace,
                }
            )

        return self._build_cleanup_result(
            task_id, "executor_deleted", deleted_executors
        )

    async def _release_cleanup_read_transaction(self, db: AsyncSession) -> None:
        """End the outer read transaction before slow external cleanup calls."""
        await db.rollback()

    def _preserve_executor_enabled(self, task_crd: Task) -> bool:
        """Check whether the task is marked to preserve its executor."""
        return bool(
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("preserveExecutor") == "true"
        )

    def _is_missing_executor_error(self, error: HTTPException) -> bool:
        """Return whether the delete failure means the executor is already gone."""
        detail = str(error.detail).lower()
        return "pod" in detail and "not found" in detail

    def _is_device_executor_name(self, executor_name: str | None) -> bool:
        """Return whether the executor name belongs to device-mode execution."""
        return bool(executor_name) and executor_name.startswith("device-")

    def _get_task_type(self, task_crd: Task) -> str:
        """Return the normalized task type label."""
        return (
            task_crd.metadata.labels and task_crd.metadata.labels.get("taskType")
        ) or "chat"

    def _get_primary_scan_batch_size(self) -> int:
        """Return the configured primary scan batch size with a safe fallback."""
        batch_size = settings.TASK_EXECUTOR_CLEANUP_PRIMARY_SCAN_BATCH_SIZE
        if not isinstance(batch_size, int) or batch_size <= 0:
            return 2000
        return batch_size

    def _get_lookback_hours(self) -> int:
        """Return the configured lookback window length with a safe fallback."""
        lookback_hours = settings.TASK_EXECUTOR_CLEANUP_LOOKBACK_HOURS
        if not isinstance(lookback_hours, int) or lookback_hours <= 0:
            return 48
        return lookback_hours

    def _get_lookback_scan_limit(self) -> int:
        """Return the configured lookback scan limit with a safe fallback."""
        lookback_limit = settings.TASK_EXECUTOR_CLEANUP_LOOKBACK_SCAN_LIMIT
        if not isinstance(lookback_limit, int) or lookback_limit <= 0:
            return 500
        return lookback_limit

    async def _archive_workspace(
        self,
        task: TaskResource,
        executor_name: str,
        executor_namespace: str,
    ) -> bool:
        """Archive workspace files before Pod deletion.

        Uses a short-lived sync session because archive_service expects
        a sync Session for its DB writes.

        Returns:
            True when it is safe to proceed with executor deletion: either
            the workspace was archived successfully, or archiving is disabled
            so there is nothing to preserve. False when archiving was required
            but failed for any reason - callers MUST skip pod deletion in that
            case to avoid unrecoverable workspace loss.
        """
        from app.services.workspace_archive import archive_service

        # With archiving disabled there is nothing to preserve, so cleanup may
        # proceed. With archiving enabled, a None result from archive_workspace
        # unambiguously signals failure (all skip/error paths return None) and
        # must block deletion.
        if not settings.WORKSPACE_ARCHIVE_ENABLED:
            return True

        logger.info(
            f"[executor_job] Archiving workspace "
            f"task_id={task.id} "
            f"executor={executor_namespace}/{executor_name}"
        )

        sync_db = SessionLocal()
        try:
            archive_info = await archive_service.archive_workspace(
                db=sync_db,
                task=task,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )
            sync_db.commit()
        except Exception as archive_error:
            sync_db.rollback()
            logger.error(
                f"[executor_job] Error archiving workspace "
                f"task_id={task.id} "
                f"executor={executor_namespace}/{executor_name}: {archive_error}",
                exc_info=True,
            )
            return False
        finally:
            sync_db.close()

        if archive_info:
            logger.info(
                f"[executor_job] Workspace archived "
                f"task_id={task.id} "
                f"size={archive_info.sizeBytes} bytes"
            )
            return True

        logger.warning(
            f"[executor_job] Workspace archiving failed, keeping executor to "
            f"avoid unrecoverable workspace loss "
            f"task_id={task.id} "
            f"executor={executor_namespace}/{executor_name}"
        )
        return False

    async def _mark_executor_deleted(self, subtask_ids: List[int]) -> None:
        """Mark selected subtasks as deleted in a short-lived sync Store boundary."""
        if not subtask_ids:
            return

        sync_db = SessionLocal()
        try:
            task_stores.subtask_store.mark_executor_deleted_by_ids(
                sync_db,
                subtask_ids=subtask_ids,
            )
            sync_db.commit()
        except Exception:
            sync_db.rollback()
            raise
        finally:
            sync_db.close()


job_service = JobService(Kind)
