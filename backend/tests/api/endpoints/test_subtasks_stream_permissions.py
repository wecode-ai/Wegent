# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.endpoints.subtasks import subscribe_group_stream
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User


def _task(task_id: int, owner_id: int) -> TaskResource:
    return TaskResource(
        id=task_id,
        user_id=owner_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {"is_group_chat": True},
            "status": {"status": "PENDING"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        is_group_chat=True,
    )


def _subtask(subtask_id: int, task_id: int, user_id: int) -> Subtask:
    return Subtask(
        id=subtask_id,
        user_id=user_id,
        task_id=task_id,
        team_id=1,
        title="streaming",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        prompt="",
        status=SubtaskStatus.RUNNING,
        progress=1,
        message_id=1,
        parent_id=0,
        error_message="",
        completed_at=datetime.now(),
    )


@pytest.mark.asyncio
async def test_subscribe_group_stream_rejects_subtask_from_other_task(
    test_db: Session,
) -> None:
    user = User(
        id=901,
        user_name="stream-owner",
        password_hash="hash",
        email="stream-owner@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.add(_task(9011, owner_id=user.id))
    test_db.add(_task(9012, owner_id=user.id))
    test_db.add(_subtask(90121, task_id=9012, user_id=user.id))
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        await subscribe_group_stream(
            task_id=9011,
            subtask_id=90121,
            current_user=user,
            db=test_db,
        )

    assert exc_info.value.status_code == 403
