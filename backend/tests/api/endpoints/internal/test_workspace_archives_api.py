# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal workspace archive API endpoints."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.workspace_archive import archive_service, archive_storage_service


def _create_task(test_db: Session, task_id: int, user_id: int) -> TaskResource:
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {
                "name": f"task-{task_id}",
                "namespace": "default",
            },
            "spec": {},
            "status": {},
        },
        is_active=TaskResource.STATE_ACTIVE,
        project_id=0,
        is_group_chat=False,
    )
    test_db.add(task)
    test_db.commit()
    test_db.refresh(task)
    return task


def _create_subtask(
    test_db: Session,
    *,
    task_id: int,
    user_id: int,
    executor_name: str,
    executor_namespace: str = "",
) -> Subtask:
    subtask = Subtask(
        user_id=user_id,
        task_id=task_id,
        team_id=1,
        title="archive-target",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        executor_namespace=executor_namespace,
        executor_name=executor_name,
        executor_deleted_at=False,
        prompt="",
        message_id=1,
        parent_id=0,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        result={"value": "done"},
        completed_at=datetime.now(),
    )
    test_db.add(subtask)
    test_db.commit()
    test_db.refresh(subtask)
    return subtask


def test_manual_archive_endpoint_updates_task_archive(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    mocker,
):
    task = _create_task(test_db, task_id=1385, user_id=test_user.id)
    _create_subtask(
        test_db,
        task_id=task.id,
        user_id=test_user.id,
        executor_name="executor-1385",
    )

    expires_at = datetime.now(timezone.utc) + timedelta(days=30)
    mocker.patch.object(
        archive_storage_service,
        "generate_upload_url",
        return_value=(
            "https://minio.example.com/upload",
            "workspace-archives/1385/archive.tar.gz",
        ),
    )
    mocker.patch.object(
        archive_storage_service,
        "calculate_expiration_time",
        return_value=expires_at,
    )
    archive_mock = mocker.patch.object(
        archive_service,
        "_call_executor_archive",
        new=AsyncMock(
            return_value={
                "size_bytes": 1024,
                "session_file_included": True,
                "git_included": True,
            }
        ),
    )

    response = test_client.post(f"/api/internal/workspace-archives/{task.id}/archive")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["task_id"] == task.id
    assert payload["archive"]["storageKey"] == "workspace-archives/1385/archive.tar.gz"
    archive_mock.assert_awaited_once()

    test_db.expire_all()
    persisted_task = (
        test_db.query(TaskResource)
        .filter(TaskResource.id == task.id, TaskResource.kind == "Task")
        .first()
    )
    persisted_archive = persisted_task.json["status"]["archive"]

    assert persisted_archive["storageKey"] == "workspace-archives/1385/archive.tar.gz"
    assert persisted_archive["sizeBytes"] == 1024
    assert (
        datetime.fromisoformat(persisted_archive["expiresAt"].replace("Z", "+00:00"))
        == expires_at
    )


def test_manual_archive_endpoint_returns_404_without_executor(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
):
    task = _create_task(test_db, task_id=1386, user_id=test_user.id)

    response = test_client.post(f"/api/internal/workspace-archives/{task.id}/archive")

    assert response.status_code == 404
    assert response.json()["detail"] == "No active executor found for task"
