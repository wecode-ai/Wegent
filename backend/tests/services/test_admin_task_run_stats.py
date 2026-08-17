# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for administrator task run statistics."""

from datetime import datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.admin_task_run_stats import get_task_run_stats
from app.services.task_run_metrics import (
    TaskRunFailureMetric,
    TaskRunMetricsUnavailable,
    TaskRunMetricWindow,
)


class _FakeMetricsStore:
    def __init__(self, window: TaskRunMetricWindow) -> None:
        self.window = window

    def load_window(self, *args: Any, **kwargs: Any) -> TaskRunMetricWindow:
        return self.window


class _UnavailableMetricsStore:
    def load_window(self, *args: Any, **kwargs: Any) -> TaskRunMetricWindow:
        raise TaskRunMetricsUnavailable("Redis unavailable")


def _create_task(test_db: Session, user: User, name: str, title: str) -> TaskResource:
    task = TaskResource(
        user_id=user.id,
        kind="Task",
        name=name,
        namespace="default",
        json={"spec": {"title": title}, "status": {"status": "PENDING"}},
    )
    test_db.add(task)
    test_db.flush()
    return task


def _create_subtask(
    test_db: Session,
    task: TaskResource,
    *,
    status: SubtaskStatus,
    created_at: datetime,
    error_message: str | None = None,
    result: dict[str, Any] | None = None,
    role: SubtaskRole = SubtaskRole.ASSISTANT,
) -> Subtask:
    subtask = Subtask(
        user_id=task.user_id,
        task_id=task.id,
        team_id=1,
        title="Run",
        bot_ids=[],
        role=role,
        status=status,
        result=result,
        error_message=error_message,
        created_at=created_at,
        updated_at=created_at,
    )
    test_db.add(subtask)
    return subtask


def test_get_task_run_stats_combines_redis_metrics_with_mysql_failure_details(
    test_db: Session,
    test_user: User,
):
    now = datetime.now()
    task = _create_task(test_db, test_user, "task-monitor", "Investigate failure")
    first_failure = _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.FAILED,
        created_at=now - timedelta(hours=1),
        error_message="  Executor   timed out\nwhile waiting  ",
    )
    second_failure = _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.FAILED,
        created_at=now - timedelta(minutes=30),
        error_message="Executor timed out while waiting",
    )
    test_db.commit()

    metrics_store = _FakeMetricsStore(
        TaskRunMetricWindow(
            total_runs=3,
            failed_runs=2,
            failure_reasons=[
                TaskRunFailureMetric(
                    reason_id="timeout",
                    reason="Executor timed out while waiting",
                    count=2,
                )
            ],
            recent_failure_ids=[second_failure.id, first_failure.id],
            data_as_of=now,
        )
    )

    response = get_task_run_stats(
        test_db,
        hours=24,
        failure_reason_limit=10,
        recent_failure_limit=20,
        metrics_store=metrics_store,
    )

    assert response.total_runs == 3
    assert response.total_is_approximate is True
    assert response.failed_runs == 2
    assert response.failure_rate == 66.7
    assert response.failure_reasons[0].reason == "Executor timed out while waiting"
    assert response.failure_reasons[0].count == 2
    assert response.failure_reasons[0].percentage == 100.0
    assert response.recent_failures[-1].subtask_id == first_failure.id
    assert response.recent_failures[0].task_title == "Investigate failure"
    assert response.recent_failures[0].user_name == test_user.user_name
    assert response.data_as_of == now


def test_get_task_run_stats_extracts_legacy_jsonl_failure_detail(
    test_db: Session,
    test_user: User,
) -> None:
    now = datetime.now()
    task = _create_task(test_db, test_user, "legacy-jsonl", "Legacy JSONL failure")
    failed = _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.FAILED,
        created_at=now,
        error_message="\n".join(
            [
                '{"type":"system","subtype":"hook_started"}',
                '{"type":"result","is_error":true,'
                '"result":"API Error: 502 Bad Gateway"}',
            ]
        ),
        result={"error_type": "runtime_error", "value": "API Error: 502 Bad Gateway"},
    )
    test_db.commit()
    metrics_store = _FakeMetricsStore(
        TaskRunMetricWindow(
            total_runs=1,
            failed_runs=1,
            failure_reasons=[],
            recent_failure_ids=[failed.id],
            data_as_of=now,
        )
    )

    response = get_task_run_stats(
        test_db,
        hours=24,
        failure_reason_limit=10,
        recent_failure_limit=20,
        metrics_store=metrics_store,
    )

    assert response.recent_failures[0].error_message == "API Error: 502 Bad Gateway"


def test_admin_task_run_stats_endpoint(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
    monkeypatch,
):
    task = _create_task(test_db, test_user, "task-monitor-api", "API failure")
    failed = _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.FAILED,
        created_at=datetime.now() - timedelta(minutes=5),
        error_message="Executor unavailable",
    )
    test_db.commit()
    metrics_store = _FakeMetricsStore(
        TaskRunMetricWindow(
            total_runs=1,
            failed_runs=1,
            failure_reasons=[
                TaskRunFailureMetric(
                    reason_id="unavailable",
                    reason="Executor unavailable",
                    count=1,
                )
            ],
            recent_failure_ids=[failed.id],
            data_as_of=datetime.now(),
        )
    )
    monkeypatch.setattr(
        "app.services.admin_task_run_stats.task_run_metrics_store", metrics_store
    )

    response = test_client.get(
        "/api/admin/task-runs/stats?hours=24",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_runs"] == 1
    assert payload["failed_runs"] == 1
    assert payload["total_is_approximate"] is True
    assert payload["failure_reasons"][0]["reason"] == "Executor unavailable"


def test_admin_task_run_stats_endpoint_returns_503_when_redis_is_unavailable(
    test_client: TestClient,
    test_admin_token: str,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.services.admin_task_run_stats.task_run_metrics_store",
        _UnavailableMetricsStore(),
    )

    response = test_client.get(
        "/api/admin/task-runs/stats?hours=24",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "Task run metrics are temporarily unavailable"
