# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from collections.abc import Iterator
from datetime import datetime
from typing import Any, Literal, Optional
from unittest.mock import Mock

import pytest
from sqlalchemy import event, select
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
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


@pytest.fixture
def history_statements(test_db: Session) -> Iterator[list[str]]:
    statements: list[str] = []
    connection = test_db.connection()

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(connection, "before_cursor_execute", capture)
    try:
        yield statements
    finally:
        event.remove(connection, "before_cursor_execute", capture)


def _assert_id_sort_projection(statements: list[str], *, empty: bool = False) -> None:
    ordered = [statement for statement in statements if "ORDER BY" in statement]
    assert len(ordered) == (0 if empty else 1)
    for statement in ordered:
        projection = statement.split("FROM", 1)[0]
        assert "subtasks.id" in projection
        # SQLite accepts the old MySQL filesort of large JSON/text columns.
        # Check the executed SQL so that query cannot regress unnoticed.
        for column in ("result", "prompt", "error_message"):
            assert f"subtasks.{column}" not in projection


@pytest.mark.parametrize("owner_id", [None, 10, 20])
def test_assistant_history_sorts_ids_without_sorting_large_payloads(
    test_db: Session,
    assistant_history: dict,
    history_statements: list[str],
    owner_id: Optional[int],
) -> None:
    subtasks = SqlAlchemySubtaskStore().list_assistant_by_task(
        test_db, task_id=42, owner_user_id=owner_id
    )

    assert [subtask.id for subtask in subtasks] == ([] if owner_id == 20 else [44, 42])
    for subtask in subtasks:
        assert subtask.result == assistant_history
        assert subtask.prompt == "original prompt"
        assert subtask.error_message == "Task output exceeded the device callback limit"
    _assert_id_sort_projection(history_statements)


@pytest.mark.parametrize(
    ("order_by", "options", "owner_id", "expected_ids"),
    [
        ("message_id", {}, 10, [44, 42, 41]),
        ("created_at", {}, 10, [44, 41, 42]),
        ("id", {}, 10, [41, 42, 44]),
        ("message_id", {"message_ids": [1, 4]}, 10, [44, 41]),
        ("message_id", {"exclude_subtask_ids": [42]}, 10, [44, 41]),
        ("message_id", {"exclude_deleted": True}, 10, [42, 41]),
        ("message_id", {"message_ids": []}, 10, []),
        ("message_id", {}, None, [44, 42, 41]),
        ("message_id", {}, 20, []),
    ],
)
def test_ordered_task_history_preserves_filters_without_sorting_large_payloads(
    test_db: Session,
    test_user: User,
    assistant_history: dict,
    history_statements: list[str],
    order_by: Literal["id", "message_id", "created_at"],
    options: dict[str, Any],
    owner_id: Optional[int],
    expected_ids: list[int],
) -> None:
    for subtask_id in (41, 42, 44):
        subtask = test_db.get(Subtask, subtask_id)
        assert subtask is not None
        subtask.created_at = datetime(2026, 1, 1 if subtask_id == 44 else 2)
        subtask.sender_user_id = test_user.id
        if subtask_id == 44:
            subtask.status = SubtaskStatus.DELETE
    test_db.flush()
    test_db.expunge_all()

    subtasks = SqlAlchemySubtaskStore().list_by_task_ordered(
        test_db,
        task_id=42,
        owner_user_id=owner_id,
        order_by=order_by,
        **options,
    )

    assert [subtask.id for subtask in subtasks] == expected_ids
    for subtask in subtasks:
        assert subtask.result == assistant_history
        assert subtask.prompt == "original prompt"
        assert subtask.error_message == "Task output exceeded the device callback limit"
        assert subtask.sender_user_name == test_user.user_name
    _assert_id_sort_projection(
        history_statements, empty=options.get("message_ids") == []
    )


@pytest.mark.parametrize(
    "chain",
    [
        [{"additional_kwargs": {"summary_compacted": True}}],
        [{"additional_kwargs": {"summary_compacted": "true"}}],
        [{"additional_kwargs": {"summary_compacted": 1}}],
        [{"additional_kwargs": {"summary_compacted": False}}],
        [{"additional_kwargs": {"summary_compacted": [True]}}],
        [{"additional_kwargs": [{"summary_compacted": True}]}],
        [[{"additional_kwargs": {"summary_compacted": True}}]],
        {"additional_kwargs": {"summary_compacted": True}},
        ["text", 1, None, {"additional_kwargs": {"summary_compacted": True}}],
        ["text", 1, None],
        None,
    ],
)
@pytest.mark.parametrize(
    ("role", "status"),
    [
        (SubtaskRole.ASSISTANT, SubtaskStatus.COMPLETED),
        (SubtaskRole.USER, SubtaskStatus.COMPLETED),
        (SubtaskRole.ASSISTANT, SubtaskStatus.FAILED),
    ],
)
def test_checkpoint_database_filter_matches_exact_marker_contract(
    test_db,
    history_statements,
    chain,
    role,
    status,
):
    from app.services.chat.compaction_checkpoint import subtask_has_summary_checkpoint
    from tests.services.test_task_fork_history import _subtask, _task

    row = _subtask(1, 42, 7, 1, role)
    row.status = status
    row.result = {
        "messages_chain": chain,
        "context_compactions": [{"status": "completed"}],
    }
    test_db.add_all([_task(42, 7), row])
    test_db.flush()
    expected = [1] if subtask_has_summary_checkpoint(row) else []
    test_db.expunge_all()
    history_statements.clear()

    selected = SqlAlchemySubtaskStore().list_by_task_ordered(
        test_db,
        task_id=42,
        owner_user_id=7,
        recent_limit=1,
        summary_checkpoint_only=True,
    )

    assert [row.id for row in selected] == expected
    _assert_id_sort_projection(history_statements)
    assert "LIMIT" in next(sql for sql in history_statements if "ORDER BY" in sql)


def test_mysql_checkpoint_lookup_cannot_flatten_into_a_payload_sort() -> None:
    from app.stores.tasks.history_checkpoint import summary_checkpoint_predicate

    db = Mock(spec=Session)
    db.get_bind.return_value.dialect.name = "mysql"
    query = (
        select(Subtask.id)
        .where(summary_checkpoint_predicate(db, Subtask))
        .order_by(
            Subtask.message_id.desc(), Subtask.created_at.desc(), Subtask.id.desc()
        )
        .limit(1)
    )

    statement = str(query.compile(dialect=mysql.dialect()))

    assert "(SELECT 1 FROM JSON_TABLE(" in statement
    assert "'true' LIMIT 1) = 1" in statement
    assert "EXISTS" not in statement
    assert "subtasks.result" not in statement.split("FROM", 1)[0]
