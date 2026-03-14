# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_task_with_executor_bound_subtask(
    db: Session,
    user: User,
    executor_namespace: str = "default",
) -> TaskResource:
    task_json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": "task-remote-workspace-integration",
            "namespace": "default",
            "labels": {
                "type": "offline",
                "taskType": "code",
                "source": "web",
            },
        },
        "spec": {
            "title": "Remote workspace integration task",
            "prompt": "test prompt",
            "teamRef": {"name": "integration-team", "namespace": "default"},
            "workspaceRef": {"name": "workspace-integration", "namespace": "default"},
        },
        "status": {
            "status": "FAILED",
            "progress": 100,
            "result": None,
            "errorMessage": "forced failure",
            "createdAt": datetime.now().isoformat(),
            "updatedAt": datetime.now().isoformat(),
            "completedAt": datetime.now().isoformat(),
        },
    }

    task = TaskResource(
        user_id=user.id,
        kind="Task",
        name="task-remote-workspace-integration",
        namespace="default",
        json=task_json,
        is_active=True,
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    assistant_subtask = Subtask(
        user_id=user.id,
        task_id=task.id,
        team_id=1,
        title="assistant",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        executor_namespace=executor_namespace,
        executor_name="executor-integration",
        prompt="",
        status=SubtaskStatus.FAILED,
        progress=100,
        message_id=1,
        parent_id=0,
        error_message="forced failure",
        completed_at=datetime.now(),
        result={"value": "failed"},
    )
    db.add(assistant_subtask)
    db.commit()

    return task


def test_remote_workspace_status_connected_but_unavailable_integration(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
):
    task = _create_task_with_executor_bound_subtask(test_db, test_user)

    with (
        patch(
            "app.services.remote_workspace_service.RemoteWorkspaceService._get_sandbox_payload",
            return_value=None,
        ),
        patch(
            "app.services.remote_workspace_service.RemoteWorkspaceService._get_executor_payload",
            return_value=None,
        ),
    ):
        response = test_client.get(
            f"/api/tasks/{task.id}/remote-workspace/status",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["connected"] is True
    assert payload["available"] is False
    assert payload["root_path"] == f"/workspace/{task.id}"
    assert payload["reason"] == "sandbox_not_running"


def test_remote_workspace_status_connected_when_namespace_empty_integration(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
):
    task = _create_task_with_executor_bound_subtask(
        test_db,
        test_user,
        executor_namespace="",
    )

    with (
        patch(
            "app.services.remote_workspace_service.RemoteWorkspaceService._get_sandbox_payload",
            return_value=None,
        ),
        patch(
            "app.services.remote_workspace_service.RemoteWorkspaceService._get_executor_payload",
            return_value=None,
        ),
    ):
        response = test_client.get(
            f"/api/tasks/{task.id}/remote-workspace/status",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["connected"] is True
    assert payload["available"] is False
    assert payload["root_path"] == f"/workspace/{task.id}"
    assert payload["reason"] == "sandbox_not_running"


def test_remote_workspace_tree_root_path_and_escape_guard_integration(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
):
    task = _create_task_with_executor_bound_subtask(test_db, test_user)

    with (
        patch(
            "app.services.remote_workspace_service.RemoteWorkspaceService._get_sandbox_payload",
            return_value=None,
        ),
        patch(
            "app.services.remote_workspace_service.RemoteWorkspaceService._get_executor_payload",
            return_value=None,
        ),
    ):
        root_response = test_client.get(
            f"/api/tasks/{task.id}/remote-workspace/tree",
            params={"path": "/workspace"},
            headers=_auth_header(test_token),
        )

    assert root_response.status_code == 409
    assert root_response.json()["detail"] == "Remote workspace is unavailable"

    escape_response = test_client.get(
        f"/api/tasks/{task.id}/remote-workspace/tree",
        params={"path": "/workspace/../etc"},
        headers=_auth_header(test_token),
    )

    assert escape_response.status_code == 400
    assert (
        escape_response.json()["detail"]
        == f"Path must stay within /workspace/{task.id}"
    )
