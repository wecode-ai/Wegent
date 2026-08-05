# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Aggregate assistant task run statuses for administrator monitoring."""

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Query, Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.admin_task_runs import (
    RecentTaskRunFailure,
    TaskRunFailureReason,
    TaskRunStatsResponse,
)


def get_task_run_stats(
    db: Session,
    *,
    hours: int,
    failure_reason_limit: int,
    recent_failure_limit: int,
) -> TaskRunStatsResponse:
    """Return assistant run statistics for tasks created within the window."""
    window_end = datetime.now()
    window_start = window_end - timedelta(hours=hours)
    status_counts = _load_status_counts(db, window_start, window_end)
    failed_count = status_counts[SubtaskStatus.FAILED.value]
    terminal_count = failed_count + status_counts[SubtaskStatus.COMPLETED.value]

    return TaskRunStatsResponse(
        hours=hours,
        window_start=window_start,
        window_end=window_end,
        total_runs=sum(status_counts.values()),
        by_status=status_counts,
        success_rate=_percentage(
            status_counts[SubtaskStatus.COMPLETED.value], terminal_count
        ),
        failure_rate=_percentage(failed_count, terminal_count),
        failure_reasons=_load_failure_reasons(
            db,
            window_start,
            window_end,
            failed_count,
            failure_reason_limit,
        ),
        recent_failures=_load_recent_failures(
            db, window_start, window_end, recent_failure_limit
        ),
    )


def _task_run_query(db: Session, window_start: datetime, window_end: datetime) -> Query:
    return (
        db.query(Subtask)
        .join(TaskResource, TaskResource.id == Subtask.task_id)
        .filter(
            TaskResource.kind == "Task",
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.created_at >= window_start,
            Subtask.created_at <= window_end,
        )
    )


def _load_status_counts(
    db: Session, window_start: datetime, window_end: datetime
) -> dict[str, int]:
    counts = {status.value: 0 for status in SubtaskStatus}
    rows = (
        _task_run_query(db, window_start, window_end)
        .with_entities(Subtask.status, func.count(Subtask.id))
        .group_by(Subtask.status)
        .all()
    )
    for status, count in rows:
        status_value = (
            status.value if isinstance(status, SubtaskStatus) else str(status)
        )
        counts[status_value] = int(count)
    return counts


def _load_failure_reasons(
    db: Session,
    window_start: datetime,
    window_end: datetime,
    failed_count: int,
    limit: int,
) -> list[TaskRunFailureReason]:
    rows = (
        _task_run_query(db, window_start, window_end)
        .filter(Subtask.status == SubtaskStatus.FAILED)
        .with_entities(
            Subtask.error_message,
            func.count(Subtask.id),
            func.max(Subtask.updated_at),
        )
        .group_by(Subtask.error_message)
        .order_by(func.count(Subtask.id).desc(), func.max(Subtask.updated_at).desc())
        .limit(limit * 5)
        .all()
    )
    merged = _merge_failure_reasons(rows)
    return [
        TaskRunFailureReason(
            reason=reason,
            count=count,
            percentage=_percentage(count, failed_count),
            latest_at=latest_at,
        )
        for reason, count, latest_at in merged[:limit]
    ]


def _merge_failure_reasons(
    rows: list[tuple],
) -> list[tuple[Optional[str], int, datetime]]:
    merged: dict[Optional[str], dict[str, object]] = defaultdict(
        lambda: {"count": 0, "latest_at": datetime.min}
    )
    for error_message, count, latest_at in rows:
        reason = _normalize_failure_reason(error_message)
        merged[reason]["count"] = int(merged[reason]["count"]) + int(count)
        merged[reason]["latest_at"] = max(merged[reason]["latest_at"], latest_at)
    result = [
        (reason, int(values["count"]), values["latest_at"])
        for reason, values in merged.items()
    ]
    return sorted(result, key=lambda item: (item[1], item[2]), reverse=True)


def _load_recent_failures(
    db: Session, window_start: datetime, window_end: datetime, limit: int
) -> list[RecentTaskRunFailure]:
    rows = (
        _task_run_query(db, window_start, window_end)
        .filter(Subtask.status == SubtaskStatus.FAILED)
        .outerjoin(User, User.id == Subtask.user_id)
        .with_entities(Subtask, TaskResource, User)
        .order_by(Subtask.updated_at.desc(), Subtask.id.desc())
        .limit(limit)
        .all()
    )
    return [_recent_failure(subtask, task, user) for subtask, task, user in rows]


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
        error_message=_normalize_failure_reason(subtask.error_message),
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


def _normalize_failure_reason(error_message: Optional[str]) -> Optional[str]:
    if not error_message or not error_message.strip():
        return None
    return " ".join(error_message.split())


def _percentage(count: int, total: int) -> float:
    return round(count * 100 / total, 1) if total else 0.0
