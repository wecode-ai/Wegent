#
# SPDX-License-Identifier: Apache-2.0

"""Fail RUNNING subtasks whose runtime disappeared or stopped reporting.

Dispatch marks a subtask RUNNING, but nothing guarantees a terminal event
afterwards. Executor Pods can be garbage collected, evicted or manually
deleted, and queued work can be lost before it ever starts. Those subtasks
previously stayed RUNNING forever because the executor-side timeout is
measured in hours and no sweep looked at the database.

This sweep emits a terminal ERROR event so the database, WebSocket clients and
completion handlers all settle instead of waiting for a runtime that is gone.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.execution.emitters import (
    StatusUpdatingEmitter,
    WebSocketResultEmitter,
)
from app.services.execution.executor_health import (
    executor_heartbeat_alive,
    executor_pod_missing,
)
from shared.models import EventType, ExecutionEvent

logger = logging.getLogger(__name__)

EXECUTOR_MISSING_ERROR = (
    "任务执行器已不存在（Pod 已被回收），无法继续执行。请新建对话重新发起。"
)
EXECUTOR_SILENT_ERROR = "任务长时间没有执行事件或执行器心跳，已判定失败。请重新发起。"
EXECUTOR_NOT_STARTED_ERROR = (
    "任务已进入运行状态但执行器始终未就绪，已判定失败。请重新发起。"
)

# Runtimes that are not managed by executor_manager. Their liveness must not
# be probed through the Pod API, otherwise healthy in-process chats look dead.
LOCAL_EXECUTOR_NAMES = frozenset({"inprocess-chat", "inprocess_chat"})


@dataclass(frozen=True)
class StalledCandidate:
    """Read-only snapshot of one RUNNING subtask."""

    task_id: int
    subtask_id: int
    user_id: int
    executor_name: str
    executor_namespace: str
    updated_at: datetime


def list_stalled_candidates(
    db: Session,
    *,
    cutoff: datetime,
    max_age_cutoff: datetime,
    limit: int,
) -> List[StalledCandidate]:
    """Return recent RUNNING assistant subtasks that have not reported since cutoff."""
    rows = (
        db.query(
            Subtask.task_id,
            Subtask.id,
            TaskResource.user_id,
            Subtask.executor_name,
            Subtask.executor_namespace,
            Subtask.updated_at,
        )
        .join(TaskResource, TaskResource.id == Subtask.task_id)
        .filter(
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.status == SubtaskStatus.RUNNING,
            Subtask.updated_at <= cutoff,
            Subtask.updated_at >= max_age_cutoff,
            TaskResource.is_active != TaskResource.STATE_DELETED,
        )
        .order_by(Subtask.updated_at.asc(), Subtask.id.asc())
        .limit(limit)
        .all()
    )
    return [
        StalledCandidate(
            task_id=row[0],
            subtask_id=row[1],
            user_id=row[2],
            executor_name=(row[3] or "").strip(),
            executor_namespace=(row[4] or "").strip(),
            updated_at=row[5],
        )
        for row in rows
    ]


class StalledSubtaskSweeper:
    """Classify and fail RUNNING subtasks that can no longer make progress."""

    def __init__(
        self,
        *,
        silent_timeout_seconds: int,
        heartbeat_timeout_seconds: int,
        heartbeat_check_enabled: bool = False,
    ) -> None:
        self._silent_timeout = timedelta(seconds=silent_timeout_seconds)
        self._heartbeat_timeout = timedelta(seconds=heartbeat_timeout_seconds)
        self._heartbeat_check_enabled = heartbeat_check_enabled

    def candidates(
        self,
        db: Session,
        *,
        now: datetime,
        max_age_seconds: int,
        limit: int,
    ) -> List[StalledCandidate]:
        """Load candidates for the given sweep time."""
        return list_stalled_candidates(
            db,
            cutoff=now - self._silent_timeout,
            max_age_cutoff=now - timedelta(seconds=max_age_seconds),
            limit=limit,
        )

    async def classify(
        self, candidate: StalledCandidate, *, now: datetime
    ) -> Optional[Tuple[str, str]]:
        """Return the failure message and code, or None when still healthy."""
        executor_name = candidate.executor_name
        if not executor_name:
            if (now - candidate.updated_at) < self._heartbeat_timeout:
                return None
            return (EXECUTOR_NOT_STARTED_ERROR, "executor_not_started")
        if (
            executor_name.startswith("device-")
            or executor_name in LOCAL_EXECUTOR_NAMES
            or candidate.executor_namespace == "standalone"
        ):
            # Local devices report through their own channel; never fail them here.
            return None

        if await executor_pod_missing(executor_name, candidate.executor_namespace):
            return (EXECUTOR_MISSING_ERROR, "executor_missing")

        if not self._heartbeat_check_enabled:
            # Not every executor image reports heartbeats, so an absent key is
            # not proof of death and must never fail a live Pod by default.
            return None

        # A live Pod may legitimately run a long tool call, so only a clearly
        # longer gap without any heartbeat counts as stalled.
        if (now - candidate.updated_at) < self._heartbeat_timeout:
            return None
        # An unknown heartbeat answer must not fail a healthy task, so only a
        # clear "dead" result is treated as a stalled runtime.
        if await executor_heartbeat_alive(candidate.task_id) is False:
            return (EXECUTOR_SILENT_ERROR, "executor_heartbeat_timeout")
        return None


async def fail_stalled_subtask(
    candidate: StalledCandidate,
    *,
    error_message: str,
    error_code: str,
) -> bool:
    """Emit a terminal ERROR event so DB, WebSocket and events all settle."""
    logger.warning(
        "[StalledTasks] Failing stalled subtask task_id=%s subtask_id=%s "
        "executor=%s/%s code=%s last_update=%s",
        candidate.task_id,
        candidate.subtask_id,
        candidate.executor_namespace,
        candidate.executor_name,
        error_code,
        candidate.updated_at,
    )
    event = ExecutionEvent(
        type=EventType.ERROR.value,
        task_id=candidate.task_id,
        subtask_id=candidate.subtask_id,
        error=error_message,
        error_code=error_code,
        executor_name=candidate.executor_name or None,
        executor_namespace=candidate.executor_namespace or None,
    )
    emitter = StatusUpdatingEmitter(
        wrapped=WebSocketResultEmitter(
            task_id=candidate.task_id,
            subtask_id=candidate.subtask_id,
            user_id=candidate.user_id,
        ),
        task_id=candidate.task_id,
        subtask_id=candidate.subtask_id,
        executor_name=candidate.executor_name or None,
        executor_namespace=candidate.executor_namespace or None,
    )
    try:
        await emitter.emit(event)
        await emitter.close()
    except Exception as exc:
        logger.error(
            "[StalledTasks] Failed to fail subtask %s: %s",
            candidate.subtask_id,
            exc,
        )
        return False
    return True


async def sweep_stalled_subtasks(
    db,
    *,
    silent_timeout_seconds: int,
    max_age_seconds: int,
    heartbeat_timeout_seconds: int,
    limit: int,
    heartbeat_check_enabled: bool = False,
    now: Optional[datetime] = None,
) -> List[int]:
    """Run one sweep against an ``AsyncSession`` and return failed subtask ids."""
    current_time = now or datetime.now()
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=silent_timeout_seconds,
        heartbeat_timeout_seconds=heartbeat_timeout_seconds,
        heartbeat_check_enabled=heartbeat_check_enabled,
    )
    candidates = await db.run_sync(
        lambda sync_db: sweeper.candidates(
            sync_db,
            now=current_time,
            max_age_seconds=max_age_seconds,
            limit=limit,
        )
    )

    failed: List[int] = []
    for candidate in candidates:
        reason = await sweeper.classify(candidate, now=current_time)
        if reason is None:
            continue
        error_message, error_code = reason
        if await fail_stalled_subtask(
            candidate, error_message=error_message, error_code=error_code
        ):
            failed.append(candidate.subtask_id)
    return failed
