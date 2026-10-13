# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.remote_workspace_service import remote_workspace_service


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
        response = remote_workspace_service.get_status(
            db=test_db, task_id=task.id, user_id=test_user.id
        )

    payload = response.model_dump()
    assert payload["connected"] is True
    assert payload["available"] is False
    assert payload["root_path"] == f"/workspace/{task.id}"
    assert payload["reason"] == "sandbox_not_running"


def test_remote_workspace_status_connected_when_namespace_empty_integration(
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
        response = remote_workspace_service.get_status(
            db=test_db, task_id=task.id, user_id=test_user.id
        )

    payload = response.model_dump()
    assert payload["connected"] is True
    assert payload["available"] is False
    assert payload["root_path"] == f"/workspace/{task.id}"
    assert payload["reason"] == "sandbox_not_running"


def test_remote_workspace_tree_root_path_and_escape_guard_integration(
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
        with pytest.raises(HTTPException) as unavailable:
            remote_workspace_service.list_tree(
                db=test_db, task_id=task.id, user_id=test_user.id, path="/workspace"
            )

    assert unavailable.value.status_code == 409
    assert unavailable.value.detail == "Remote workspace is unavailable"

    with pytest.raises(HTTPException) as escape:
        remote_workspace_service.list_tree(
            db=test_db,
            task_id=task.id,
            user_id=test_user.id,
            path="/srv/workspaces/demo-12345678/../other",
        )

    assert escape.value.status_code == 400
    assert escape.value.detail == "Parent traversal is not allowed"
