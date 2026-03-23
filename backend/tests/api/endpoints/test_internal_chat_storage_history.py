# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User


def _create_subtask(
    db: Session,
    *,
    user_id: int,
    task_id: int,
    message_id: int,
    status: SubtaskStatus,
    content: str,
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
        result={"value": content},
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
        content="failed-message",
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
