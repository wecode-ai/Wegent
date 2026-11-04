# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore


@pytest.fixture
def assistant_history(test_db: Session) -> dict:
    result = {"value": "中" * 340_000, "error_type": "device_callback_too_large"}
    for task_id, owner_id in [(42, 10), (43, 20)]:
        test_db.add(
            TaskResource(
                id=task_id,
                user_id=owner_id,
                kind="Task",
                name=f"task-{task_id}",
                namespace="default",
                json={},
            )
        )
    for subtask_id, task_id, message_id, role in [
        (41, 42, 4, SubtaskRole.USER),
        (42, 42, 3, SubtaskRole.ASSISTANT),
        (43, 43, 2, SubtaskRole.ASSISTANT),
        (44, 42, 1, SubtaskRole.ASSISTANT),
    ]:
        test_db.add(
            Subtask(
                id=subtask_id,
                task_id=task_id,
                user_id=10,
                team_id=1,
                title=f"message-{message_id}",
                bot_ids=[],
                role=role,
                prompt="original prompt",
                message_id=message_id,
                status=SubtaskStatus.FAILED,
                result=result,
                error_message="Task output exceeded the device callback limit",
            )
        )
    test_db.flush()
    test_db.expunge_all()
    return result


@pytest.mark.parametrize("owner_id", [None, 10, 20])
def test_assistant_history_sorts_ids_without_sorting_large_payloads(
    test_db: Session, assistant_history: dict, owner_id: Optional[int]
) -> None:
    statements: list[str] = []
    connection = test_db.connection()

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(connection, "before_cursor_execute", capture)
    try:
        subtasks = SqlAlchemySubtaskStore().list_assistant_by_task(
            test_db, task_id=42, owner_user_id=owner_id
        )
    finally:
        event.remove(connection, "before_cursor_execute", capture)

    assert [subtask.id for subtask in subtasks] == ([] if owner_id == 20 else [44, 42])
    for subtask in subtasks:
        assert subtask.result == assistant_history
        assert subtask.prompt == "original prompt"
        assert subtask.error_message == "Task output exceeded the device callback limit"
    ordered = [statement for statement in statements if "ORDER BY" in statement]
    assert len(ordered) == 1
    projection = ordered[0].split("FROM", 1)[0]
    assert "subtasks.id" in projection
    # MySQL filesort must not carry the large JSON/text columns. SQLite alone
    # accepts that old query, so check the SQL actually used by the store.
    for column in ("result", "prompt", "error_message"):
        assert f"subtasks.{column}" not in projection
