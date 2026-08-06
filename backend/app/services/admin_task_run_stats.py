# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read administrator task run statistics from Redis and failure details from MySQL."""

from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.admin_task_runs import (
    RecentTaskRunFailure,
    TaskRunFailureReason,
    TaskRunStatsResponse,
)
from app.services.task_run_metrics import (
    TaskRunMetricsStore,
    normalize_failure_reason,
    task_run_failure_message,
    task_run_metrics_store,
)


def get_task_run_stats(
    db: Session,
    *,
    hours: int,
    failure_reason_limit: int,
    recent_failure_limit: int,
    metrics_store: Optional[TaskRunMetricsStore] = None,
) -> TaskRunStatsResponse:
    """Return approximate totals and current failure details for a time window."""
    window_end = datetime.now()
    window_start = window_end - timedelta(hours=hours)
    store = metrics_store or task_run_metrics_store
    metrics = store.load_window(
        window_start,
        window_end,
        failure_reason_limit=failure_reason_limit,
        recent_failure_limit=recent_failure_limit,
    )

    return TaskRunStatsResponse(
        hours=hours,
        window_start=window_start,
        window_end=window_end,
        total_runs=metrics.total_runs,
        total_is_approximate=True,
        failed_runs=metrics.failed_runs,
        failure_rate=_percentage(metrics.failed_runs, metrics.total_runs),
        failure_reasons=[
            TaskRunFailureReason(
                reason=item.reason,
                count=item.count,
                percentage=_percentage(item.count, metrics.failed_runs),
            )
            for item in metrics.failure_reasons
        ],
        recent_failures=_load_recent_failures(
            db, metrics.recent_failure_ids, recent_failure_limit
        ),
        data_as_of=metrics.data_as_of,
    )


def _load_recent_failures(
    db: Session, subtask_ids: list[int], limit: int
) -> list[RecentTaskRunFailure]:
    if not subtask_ids:
        return []
    rows = (
        db.query(Subtask, TaskResource, User)
        .join(TaskResource, TaskResource.id == Subtask.task_id)
        .outerjoin(User, User.id == Subtask.user_id)
        .filter(
            Subtask.id.in_(subtask_ids),
            Subtask.status == SubtaskStatus.FAILED,
            TaskResource.kind == "Task",
        )
        .all()
    )
    order = {subtask_id: index for index, subtask_id in enumerate(subtask_ids)}
    rows.sort(key=lambda row: order.get(row[0].id, len(order)))
    return [
        _recent_failure(subtask, task, user) for subtask, task, user in rows[:limit]
    ]


def _recent_failure(
    subtask: Subtask, task: TaskResource, user: Optional[User]
) -> RecentTaskRunFailure:
    return RecentTaskRunFailure(
        subtask_id=subtask.id,
        task_id=task.id,
        task_title=_task_title(task),
        user_id=subtask.user_id,
        user_name=user.user_name if user else None,
        client_origin=task.client_origin,
        error_message=normalize_failure_reason(
            task_run_failure_message(subtask.error_message, subtask.result)
        ),
        created_at=subtask.created_at,
        updated_at=subtask.updated_at,
    )


def _task_title(task: TaskResource) -> str:
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
    metadata = (
        task_json.get("metadata") if isinstance(task_json.get("metadata"), dict) else {}
    )
    return str(
        spec.get("title")
        or metadata.get("displayName")
        or task.name
        or f"Task #{task.id}"
    )


def _percentage(count: int, total: int) -> float:
    return round(count * 100 / total, 1) if total else 0.0
