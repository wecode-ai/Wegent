# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for administrator task run statistics."""

from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.admin_task_run_stats import get_task_run_stats


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
        error_message=error_message,
        created_at=created_at,
        updated_at=created_at,
    )
    test_db.add(subtask)
    return subtask


def test_get_task_run_stats_aggregates_assistant_runs_and_failures(
    test_db: Session,
    test_user: User,
):
    now = datetime.now()
    task = _create_task(test_db, test_user, "task-monitor", "Investigate failure")
    completed = _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.COMPLETED,
        created_at=now - timedelta(hours=2),
    )
    first_failure = _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.FAILED,
        created_at=now - timedelta(hours=1),
        error_message="  Executor   timed out\nwhile waiting  ",
    )
    _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.FAILED,
        created_at=now - timedelta(minutes=30),
        error_message="Executor timed out while waiting",
    )
    _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.COMPLETED,
        created_at=now - timedelta(minutes=10),
        role=SubtaskRole.USER,
    )
    _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.FAILED,
        created_at=now - timedelta(days=2),
        error_message="Old failure",
    )
    test_db.commit()

    response = get_task_run_stats(
        test_db,
        hours=24,
        failure_reason_limit=10,
        recent_failure_limit=20,
    )

    assert response.total_runs == 3
    assert response.by_status["COMPLETED"] == 1
    assert response.by_status["FAILED"] == 2
    assert response.success_rate == 33.3
    assert response.failure_rate == 66.7
    assert response.failure_reasons[0].reason == "Executor timed out while waiting"
    assert response.failure_reasons[0].count == 2
    assert response.failure_reasons[0].percentage == 100.0
    assert response.recent_failures[-1].subtask_id == first_failure.id
    assert response.recent_failures[0].task_title == "Investigate failure"
    assert response.recent_failures[0].user_name == test_user.user_name
    assert completed.id is not None


def test_admin_task_run_stats_endpoint(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_token: str,
):
    task = _create_task(test_db, test_user, "task-monitor-api", "API failure")
    _create_subtask(
        test_db,
        task,
        status=SubtaskStatus.FAILED,
        created_at=datetime.now() - timedelta(minutes=5),
        error_message="Executor unavailable",
    )
    test_db.commit()

    response = test_client.get(
        "/api/admin/task-runs/stats?hours=24",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_runs"] == 1
    assert payload["by_status"]["FAILED"] == 1
    assert payload["failure_reasons"][0]["reason"] == "Executor unavailable"
