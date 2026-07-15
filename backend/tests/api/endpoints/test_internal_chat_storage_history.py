# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User


@pytest.fixture(autouse=True)
def configure_internal_chat_auth(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")
    test_client.headers["Authorization"] = "Bearer test-internal-token"


def _create_task_resource(db: Session, *, user_id: int, task_id: int) -> TaskResource:
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {
                "title": f"task-{task_id}",
                "prompt": "",
                "teamRef": {"name": "team", "namespace": "default"},
                "workspaceRef": {"name": "workspace", "namespace": "default"},
            },
            "status": {"state": "Available", "status": "COMPLETED"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="wework",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _create_subtask(
    db: Session,
    *,
    user_id: int,
    task_id: int,
    message_id: int,
    status: SubtaskStatus,
    content: str | None,
    result_override: dict | None = None,
) -> Subtask:
    subtask = Subtask(
        user_id=user_id,
        task_id=task_id,
        team_id=1,
        title=f"message-{message_id}",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        prompt="",
        message_id=message_id,
        parent_id=0,
        status=status,
        progress=100,
        result=(
            result_override
            if result_override is not None
            else ({"value": content} if content is not None else None)
        ),
        completed_at=datetime.now(),
    )
    db.add(subtask)
    db.commit()
    db.refresh(subtask)
    return subtask


def test_internal_chat_history_includes_cancelled_subtasks(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
):
    task_id = 9527
    _create_task_resource(test_db, user_id=test_user.id, task_id=task_id)
    completed = _create_subtask(
        test_db,
        user_id=test_user.id,
        task_id=task_id,
        message_id=1,
        status=SubtaskStatus.COMPLETED,
        content="completed-message",
    )
    cancelled = _create_subtask(
        test_db,
        user_id=test_user.id,
        task_id=task_id,
        message_id=2,
        status=SubtaskStatus.CANCELLED,
        content="cancelled-message",
    )
    _create_subtask(
        test_db,
        user_id=test_user.id,
        task_id=task_id,
        message_id=3,
        status=SubtaskStatus.FAILED,
        content=None,
    )

    response = test_client.get(f"/api/internal/chat/history/task-{task_id}")

    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == f"task-{task_id}"

    messages = payload["messages"]
    assert [item["id"] for item in messages] == [str(completed.id), str(cancelled.id)]
    assert [item["content"] for item in messages] == [
        "completed-message",
        "cancelled-message",
    ]


def test_internal_chat_history_includes_failed_only_when_value_exists(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
):
    task_id = 9531
    _create_task_resource(test_db, user_id=test_user.id, task_id=task_id)
    completed = _create_subtask(
        test_db,
        user_id=test_user.id,
        task_id=task_id,
        message_id=1,
        status=SubtaskStatus.COMPLETED,
        content="completed-message",
    )
    failed_with_value = _create_subtask(
        test_db,
        user_id=test_user.id,
        task_id=task_id,
        message_id=2,
        status=SubtaskStatus.FAILED,
        content="partial-failed-message",
        result_override={
            "value": "partial-failed-message",
            "messages_chain": [
                {"role": "assistant", "content": "tool call detail"},
                {"role": "assistant", "content": "another detail"},
            ],
        },
    )
    _create_subtask(
        test_db,
        user_id=test_user.id,
        task_id=task_id,
        message_id=3,
        status=SubtaskStatus.FAILED,
        content=None,
    )

    response = test_client.get(f"/api/internal/chat/history/task-{task_id}")

    assert response.status_code == 200
    payload = response.json()
    messages = payload["messages"]
    assert [item["id"] for item in messages] == [
        str(completed.id),
        str(failed_with_value.id),
    ]
    assert [item["content"] for item in messages] == [
        "completed-message",
        "partial-failed-message",
    ]
