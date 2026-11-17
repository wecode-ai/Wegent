# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise actual DB projections, caps, owner checks and legacy evidence."""

import pytest
from sqlalchemy import event
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Query

from app.models.subtask import SubtaskRole
from app.stores.tasks.executor_sessions import SUBSCRIPTION_SESSION_LIMIT
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore
from tests.stores.tasks.test_sqlalchemy_subtask_store import _subtask, _task


def test_sessions_filter_before_limit_and_project_only_sessions(test_db):
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(701, 7))
    for message in range(1, 121):
        row = _subtask(
            subtask_id=7000 + message,
            task_id=701,
            user_id=7,
            message_id=message,
            role=SubtaskRole.ASSISTANT,
        )
        row.result = {"value": "large-answer" * 1000}
        if message <= 60:
            row.result["executor_session"] = {
                "agent": "Codex",
                "bot_id": 23,
                "thread_id": f"thread-{message}",
            }
        test_db.add(row)
    test_db.commit()
    test_db.expunge_all()
    statements = []

    def record(_conn, _cursor, statement, _params, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(test_db.bind, "before_cursor_execute", record)
    try:
        sessions = store.list_recent_executor_sessions_by_task(
            test_db, task_id=701, owner_user_id=7
        )
        assert store.has_executor_session_by_task(test_db, task_id=701, owner_user_id=7)
    finally:
        event.remove(test_db.bind, "before_cursor_execute", record)

    assert len(sessions) == SUBSCRIPTION_SESSION_LIMIT == 50
    assert [s["thread_id"] for s in sessions] == [
        f"thread-{i}" for i in range(60, 10, -1)
    ]
    assert all("value" not in session for session in sessions)
    assert len(statements) == 2
    assert all("LIMIT" in sql for sql in statements)
    assert "subtasks.result AS" not in statements[0]
    assert "subtasks.result" not in statements[1].split("FROM")[0]
    assert not test_db.identity_map
    assert (
        store.list_recent_executor_sessions_by_task(
            test_db, task_id=701, owner_user_id=8
        )
        == []
    )
    assert not store.has_executor_session_by_task(test_db, task_id=701, owner_user_id=8)


@pytest.mark.parametrize(
    "session",
    [None, False, 0, 0.0, "", [], {}, True, 1, "false", [0], {"old": "evidence"}],
)
def test_session_evidence_matches_python_truthiness(test_db, session):
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(701, 7))
    row = _subtask(
        subtask_id=7001,
        task_id=701,
        user_id=7,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
    )
    row.result = {"executor_session": session}
    test_db.add(row)
    test_db.commit()
    assert store.has_executor_session_by_task(
        test_db, task_id=701, owner_user_id=7
    ) is bool(session)
    assert (
        store.list_recent_executor_sessions_by_task(
            test_db, task_id=701, owner_user_id=7
        )
        == []
    )


def test_mysql_session_query_is_a_bounded_json_projection(test_db, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    db = Mock(wraps=test_db)
    db.get_bind.return_value = SimpleNamespace(dialect=SimpleNamespace(name="mysql"))
    statements = []

    def capture(query):
        statements.append(query.statement.compile(dialect=mysql.dialect()))
        return []

    monkeypatch.setattr(Query, "all", capture)
    store = SqlAlchemySubtaskStore()
    assert (
        store.list_recent_executor_sessions_by_task(db, task_id=701, owner_user_id=7)
        == []
    )
    assert len(statements) == 1
    sql = str(statements[0])
    assert sql.startswith("SELECT anon_1.session")
    assert "JSON_EXTRACT(subtasks.result," in sql
    assert "row_number() OVER (PARTITION BY" in sql
    assert "WHERE anon_1.session_rank" in sql
    assert "subtasks.result AS" not in sql
    assert "LIMIT" in sql and "user_id" in sql
    assert 50 in statements[0].params.values()
    assert "json_type(json_extract(subtasks.result," in sql.lower()


def test_repeated_other_bot_sessions_do_not_hide_current_bot_recovery(test_db):
    store = SqlAlchemySubtaskStore()
    test_db.add(_task(701, 7))
    for message in range(1, 121):
        row = _subtask(
            subtask_id=7000 + message,
            task_id=701,
            user_id=7,
            message_id=message,
            role=SubtaskRole.ASSISTANT,
        )
        row.result = {
            "value": "large-answer" * 1000,
            "executor_session": {
                "agent": "Codex",
                "botId": 23 if message == 1 else 24,
                "threadId": "current-bot" if message == 1 else "other-bot",
            },
        }
        test_db.add(row)
    test_db.commit()
    assert [
        session["threadId"]
        for session in store.list_recent_executor_sessions_by_task(
            test_db, task_id=701, owner_user_id=7, bot_ids=[23]
        )
    ] == ["current-bot"]
    assert [
        session["threadId"]
        for session in store.list_recent_executor_sessions_by_task(
            test_db, task_id=701, owner_user_id=7
        )
    ] == ["other-bot", "current-bot"]


@pytest.mark.parametrize("field", ["sessionId", "threadId"])
@pytest.mark.parametrize("empty", ["", False, 0, 0.0, [], {}])
def test_falsey_camel_case_identifiers_preserve_distinct_legacy_sessions(
    test_db, field, empty
):
    from app.services.execution.request_builder import TaskRequestBuilder

    store = SqlAlchemySubtaskStore()
    test_db.add(_task(701, 7))
    legacy_field = "session_id" if field == "sessionId" else "thread_id"
    for message in range(1, 3):
        row = _subtask(
            subtask_id=7000 + message,
            task_id=701,
            user_id=7,
            message_id=message,
            role=SubtaskRole.ASSISTANT,
        )
        row.result = {
            "executor_session": {
                "agent": "Codex",
                "botId": 23,
                field: empty,
                legacy_field: f"legacy-{message}",
            }
        }
        test_db.add(row)
    test_db.commit()
    sessions = store.list_recent_executor_sessions_by_task(
        test_db, task_id=701, owner_user_id=7, bot_ids=[23]
    )
    assert [
        session[field]
        for session in TaskRequestBuilder._merge_inherited_sessions(sessions)
    ] == ["legacy-2", "legacy-1"]


def test_explicit_null_bot_id_does_not_fall_back_to_legacy_bot_id(test_db):
    from app.services.execution.request_builder import TaskRequestBuilder

    store = SqlAlchemySubtaskStore()
    test_db.add(_task(701, 7))
    row = _subtask(
        subtask_id=7001,
        task_id=701,
        user_id=7,
        message_id=1,
        role=SubtaskRole.ASSISTANT,
    )
    row.result = {
        "executor_session": {
            "agent": "Codex",
            "botId": None,
            "bot_id": 24,
            "threadId": "generic-session",
        }
    }
    test_db.add(row)
    test_db.commit()
    sessions = store.list_recent_executor_sessions_by_task(
        test_db, task_id=701, owner_user_id=7, bot_ids=[23]
    )
    assert TaskRequestBuilder._merge_inherited_sessions(sessions) == [
        {"agent": "Codex", "threadId": "generic-session"}
    ]


def test_session_deduplication_matches_normalized_scalar_identities(test_db):
    from app.services.execution.request_builder import TaskRequestBuilder

    store = SqlAlchemySubtaskStore()
    test_db.add(_task(701, 7))
    for message, identifier in enumerate([True, "True", 1, "1"], start=1):
        row = _subtask(
            subtask_id=7000 + message,
            task_id=701,
            user_id=7,
            message_id=message,
            role=SubtaskRole.ASSISTANT,
        )
        row.result = {
            "executor_session": {
                "agent": "Codex",
                "botId": 23 if message % 2 else "23",
                "threadId": identifier,
            }
        }
        test_db.add(row)
    test_db.commit()
    sessions = store.list_recent_executor_sessions_by_task(
        test_db, task_id=701, owner_user_id=7, bot_ids=[23]
    )
    assert len(sessions) == 2
    assert [
        session["threadId"]
        for session in TaskRequestBuilder._merge_inherited_sessions(sessions)
    ] == ["1", "True"]
