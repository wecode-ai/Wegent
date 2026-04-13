# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for chat task manager subtask creation."""

from datetime import datetime

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.services.chat.storage.task_manager import create_assistant_subtask


def test_create_assistant_subtask_inherits_deleted_executor_state(
    test_db: Session,
    test_user: User,
):
    previous_subtask = Subtask(
        user_id=test_user.id,
        task_id=1385,
        team_id=1256,
        title="Previous assistant response",
        bot_ids=[1255],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="default",
        executor_name="wegent-task-user7-pod7",
        executor_deleted_at=True,
        prompt="",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=12,
        parent_id=11,
        error_message="",
        result={"value": "done"},
        completed_at=datetime.now(),
    )
    test_db.add(previous_subtask)
    test_db.commit()

    assistant_subtask = create_assistant_subtask(
        db=test_db,
        subtask_user_id=test_user.id,
        task_id=1385,
        team_id=1256,
        bot_ids=[1255],
        next_message_id=14,
        parent_id=13,
    )
    test_db.flush()

    assert assistant_subtask.executor_name == previous_subtask.executor_name
    assert assistant_subtask.executor_namespace == previous_subtask.executor_namespace
    assert assistant_subtask.executor_deleted_at is True


def test_create_assistant_subtask_defaults_to_active_executor_state(
    test_db: Session,
    test_user: User,
):
    assistant_subtask = create_assistant_subtask(
        db=test_db,
        subtask_user_id=test_user.id,
        task_id=2468,
        team_id=1256,
        bot_ids=[1255],
        next_message_id=2,
        parent_id=1,
    )
    test_db.flush()

    assert assistant_subtask.executor_name == ""
    assert assistant_subtask.executor_namespace == ""
    assert assistant_subtask.executor_deleted_at is False
