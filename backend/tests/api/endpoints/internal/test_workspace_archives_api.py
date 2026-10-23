# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal workspace archive API endpoints."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import ArchiveInfo
from app.services.workspace_archive import archive_service, archive_storage_service

ACTIVE_TASK_STATES = [TaskResource.STATE_ACTIVE, TaskResource.STATE_SUBSCRIPTION]


def _create_task(
    test_db: Session,
    task_id: int,
    user_id: int,
    *,
    is_active: int = TaskResource.STATE_ACTIVE,
) -> TaskResource:
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
        is_active=is_active,
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


@pytest.mark.parametrize("task_state", ACTIVE_TASK_STATES)
def test_manual_archive_endpoint_updates_task_archive(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    mocker,
    task_state: int,
):
    task = _create_task(
        test_db, task_id=1385, user_id=test_user.id, is_active=task_state
    )
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
    archived_at = datetime.fromisoformat(payload["archive"]["archivedAt"])
    payload_expires_at = datetime.fromisoformat(payload["archive"]["expiresAt"])
    assert archived_at.utcoffset() == timedelta(hours=8)
    assert payload_expires_at.utcoffset() == timedelta(hours=8)
    archive_mock.assert_awaited_once()

    test_db.expire_all()
    persisted_task = (
        test_db.query(TaskResource)
        .filter(TaskResource.id == task.id, TaskResource.kind == "Task")
        .first()
    )
    persisted_archive = persisted_task.json["status"]["archive"]
    persisted_archived_at = datetime.fromisoformat(persisted_archive["archivedAt"])

    assert persisted_archive["storageKey"] == "workspace-archives/1385/archive.tar.gz"
    assert persisted_archive["sizeBytes"] == 1024
    assert persisted_archived_at.utcoffset() == timedelta(hours=8)
    persisted_expires_at = datetime.fromisoformat(persisted_archive["expiresAt"])
    assert persisted_expires_at.utcoffset() == timedelta(hours=8)
    assert persisted_expires_at.astimezone(expires_at.tzinfo) == expires_at


@pytest.mark.parametrize("task_state", ACTIVE_TASK_STATES)
def test_manual_archive_endpoint_returns_404_without_executor(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    task_state: int,
):
    task = _create_task(
        test_db, task_id=1386, user_id=test_user.id, is_active=task_state
    )

    response = test_client.post(f"/api/internal/workspace-archives/{task.id}/archive")

    assert response.status_code == 404
    assert response.json()["detail"] == "No active executor found for task"


@pytest.mark.parametrize("task_state", ACTIVE_TASK_STATES)
def test_archive_sandbox_endpoint_uses_sandbox_runtime(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    mocker,
    task_state: int,
):
    task = _create_task(
        test_db, task_id=1501, user_id=test_user.id, is_active=task_state
    )
    archive_info = ArchiveInfo(
        storageKey="workspace-archives/1501/archive.tar.gz",
        archivedAt=datetime.now(timezone.utc),
        expiresAt=datetime.now(timezone.utc) + timedelta(days=30),
        sizeBytes=2048,
    )
    archive_mock = mocker.patch.object(
        archive_service,
        "archive_workspace",
        new=AsyncMock(return_value=archive_info),
    )

    response = test_client.post(
        f"/api/internal/workspace-archives/{task.id}/archive-sandbox",
        json={
            "executor_name": "sandbox-1501",
            "executor_namespace": "default",
        },
    )

    assert response.status_code == 200
    assert response.json()["archive"]["storageKey"] == archive_info.storageKey
    archive_mock.assert_awaited_once()
    assert archive_mock.await_args.kwargs["runtime_type"] == "sandbox"
    assert archive_mock.await_args.kwargs["executor_name"] == "sandbox-1501"


@pytest.mark.parametrize("task_state", ACTIVE_TASK_STATES)
def test_restore_sandbox_endpoint_uses_sandbox_runtime(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    mocker,
    task_state: int,
):
    task = _create_task(
        test_db, task_id=1502, user_id=test_user.id, is_active=task_state
    )
    restore_mock = mocker.patch.object(
        archive_service,
        "restore_workspace",
        new=AsyncMock(
            return_value={
                "success": True,
                "session_restored": False,
                "git_restored": False,
            }
        ),
    )

    response = test_client.post(
        f"/api/internal/workspace-archives/{task.id}/restore-sandbox",
        json={
            "executor_name": "sandbox-1502",
            "executor_namespace": "default",
        },
    )

    assert response.status_code == 200
    assert response.json()["success"] is True
    restore_mock.assert_awaited_once()
    assert restore_mock.await_args.kwargs["runtime_type"] == "sandbox"
    assert restore_mock.await_args.kwargs["executor_name"] == "sandbox-1502"


@pytest.mark.parametrize("task_state", ACTIVE_TASK_STATES)
def test_restore_sandbox_without_archive_is_explicitly_skipped(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    mocker,
    task_state: int,
):
    task = _create_task(
        test_db, task_id=1503, user_id=test_user.id, is_active=task_state
    )
    mocker.patch.object(
        archive_service, "restore_workspace", new=AsyncMock(return_value=None)
    )
    response = test_client.post(
        f"/api/internal/workspace-archives/{task.id}/restore-sandbox",
        json={"executor_name": "sandbox-1503", "executor_namespace": "default"},
    )
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert response.json()["skipped"] is True


@pytest.mark.parametrize("task_state", ACTIVE_TASK_STATES)
def test_restore_sandbox_with_failed_archive_reports_failure(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    mocker,
    task_state: int,
):
    task = _create_task(
        test_db, task_id=1504, user_id=test_user.id, is_active=task_state
    )
    task.json = {**task.json, "status": {"archive": {"storageKey": "archive-1504"}}}
    test_db.commit()
    mocker.patch.object(
        archive_service, "restore_workspace", new=AsyncMock(return_value=None)
    )
    response = test_client.post(
        f"/api/internal/workspace-archives/{task.id}/restore-sandbox",
        json={"executor_name": "sandbox-1504", "executor_namespace": "default"},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "sandbox_archive_restore_failed"


@pytest.mark.parametrize(
    "task_state", [TaskResource.STATE_DELETED, TaskResource.STATE_ARCHIVED]
)
@pytest.mark.parametrize("operation", ["archive", "archive-sandbox", "restore-sandbox"])
def test_archive_operations_reject_inactive_tasks(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    task_state: int,
    operation: str,
):
    task = _create_task(
        test_db, task_id=1505, user_id=test_user.id, is_active=task_state
    )

    response = test_client.post(
        f"/api/internal/workspace-archives/{task.id}/{operation}",
        json={"executor_name": "sandbox-1505", "executor_namespace": "default"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Task not found"


@pytest.fixture
def test_client(test_client):
    """Exercise retained Python HTTP components in an isolated application."""
    from tests.retained_python_handlers import component_client

    with component_client(test_client, ("restore_sandbox",)) as client:
        yield client
