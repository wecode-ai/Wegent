# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify ancillary paths do not hydrate discarded conversation payloads."""

import pytest
from sqlalchemy import event

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.services.chat.interactive_forms import get_pending_interactive_form
from app.services.chat.subtask_history import list_subtask_summaries
from app.services.context.context_service import ContextService
from app.stores.tasks import subtask_store
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore
from tests.stores.tasks.test_sqlalchemy_subtask_store import _subtask, _task


def seed(test_db):
    test_db.add(_task(701, 7))
    for message in range(1, 251):
        row = _subtask(
            subtask_id=7000 + message,
            task_id=701,
            user_id=7,
            message_id=message,
            role=SubtaskRole.ASSISTANT,
        )
        row.result = {"value": f"answer-{message}-" + "x" * 10000}
        row.executor_name = "executor-one"
        row.executor_namespace = "default"
        row.executor_deleted_at = False
        test_db.add(row)
    test_db.commit()
    test_db.expunge_all()


def test_cleanup_pages_are_bounded_projections_without_result(test_db):
    seed(test_db)
    statements = []

    def record(_conn, _cursor, sql, *_args):
        if sql.lstrip().upper().startswith("SELECT"):
            statements.append(sql)

    event.listen(test_db.bind, "before_cursor_execute", record)
    try:
        rows = list(
            SqlAlchemySubtaskStore().iter_runtime_cleanup_rows(
                test_db, task_id=701, owner_user_id=7
            )
        )
    finally:
        event.remove(test_db.bind, "before_cursor_execute", record)
    assert [row.id for row in rows] == list(range(7001, 7251))
    assert len(statements) == 4
    assert all("LIMIT" in sql for sql in statements)
    assert all(
        "subtasks.result" not in sql and "subtasks.prompt" not in sql
        for sql in statements
    )
    with pytest.raises(Exception, match="raiseload"):
        _ = rows[0].result


def test_history_tool_counts_all_but_only_hydrates_requested_page(test_db, monkeypatch):
    seed(test_db)
    store = SqlAlchemySubtaskStore()
    monkeypatch.setattr(
        subtask_store, "list_visible_history_page", store.list_visible_history_page
    )
    statements = []

    def record(_conn, _cursor, sql, *_args):
        if sql.lstrip().upper().startswith("SELECT"):
            statements.append(sql)

    event.listen(test_db.bind, "before_cursor_execute", record)
    try:
        result = list_subtask_summaries(
            test_db, task_id=701, user_id=7, limit=50, offset=50
        )
    finally:
        event.remove(test_db.bind, "before_cursor_execute", record)
    assert result["total"] == 250
    assert result["has_more"]
    assert [row["id"] for row in result["subtasks"]] == list(range(7051, 7101))
    assert len(test_db.identity_map) <= 50
    assert statements[0].startswith("SELECT count(subtasks.id)")
    assert "subtasks.result" not in statements[0]
    payload_reads = [sql for sql in statements if "subtasks.result AS" in sql]
    assert len(payload_reads) == 1 and "LIMIT" in payload_reads[0]
    assert store.list_visible_history_page(
        test_db, task_id=701, owner_user_id=8, limit=50, offset=0
    ) == ([], 0)


def test_attachments_keep_old_files_without_reading_any_subtask_payload(
    test_db, monkeypatch
):
    seed(test_db)
    for context_id, message in [(9001, 1), (9002, 250)]:
        test_db.add(
            SubtaskContext(
                id=context_id,
                subtask_id=7000 + message,
                user_id=7,
                context_type="attachment",
                status="ready",
                name=f"file-{message}",
                type_data={},
            )
        )
    test_db.commit()
    test_db.expunge_all()
    store = SqlAlchemySubtaskStore()
    monkeypatch.setattr(subtask_store, "ids_query_by_task", store.ids_query_by_task)
    attachments = ContextService().get_attachments_by_task(test_db, 701)
    assert {row.id for row in attachments} == {9001, 9002}
    assert not any(
        type(row).__name__ == "Subtask" for row in test_db.identity_map.values()
    )


@pytest.mark.parametrize("subscription", [False, True])
@pytest.mark.parametrize("limit", [None, 0, -1, 20, 10000])
def test_subscription_history_pages_cap_without_changing_ordinary_limits(
    test_db, monkeypatch, subscription, limit
):
    seed(test_db)
    store = SqlAlchemySubtaskStore()
    monkeypatch.setattr(
        subtask_store, "list_visible_history_page", store.list_visible_history_page
    )
    result = list_subtask_summaries(
        test_db,
        task_id=701,
        user_id=7,
        limit=limit,
        offset=100,
        is_subscription=subscription,
    )
    count = 150 if limit is None else max(0, min(150, limit))
    if subscription:
        count = min(50, count)
    assert result["total"] == 250
    assert [row["id"] for row in result["subtasks"]] == list(range(7101, 7101 + count))
    assert result["has_more"] == (100 + count < 250)


def _pending_form_blocks(*, valid=True):
    return [
        {
            "tool_name": "interactive_form_question",
            "tool_use_id": "pending-old-form",
            "render_payload": {
                "type": "interactive_form_question",
                "questions": [{"id": "q"}] if valid else [],
            },
        }
    ]


@pytest.mark.parametrize("answered", [False, True])
def test_subscription_form_reads_skip_large_history_and_keep_old_pending_forms(
    test_db, monkeypatch, answered
):
    seed(test_db)
    old_form = test_db.get(Subtask, 7001)
    old_form.result = {
        "value": "x" * 10000,
        "blocks": _pending_form_blocks(),
    }
    if answered:
        test_db.get(Subtask, 7100).role = SubtaskRole.USER
    test_db.commit()
    test_db.expunge_all()
    store = SqlAlchemySubtaskStore()
    monkeypatch.setattr(
        subtask_store,
        "iter_pending_form_candidates",
        store.iter_pending_form_candidates,
    )
    statements = []

    def record(_conn, _cursor, sql, *_args):
        if sql.lstrip().upper().startswith("SELECT"):
            statements.append(sql)

    event.listen(test_db.bind, "before_cursor_execute", record)
    try:
        pending = get_pending_interactive_form(
            test_db, task_id=701, subscription_owner_user_id=7
        )
    finally:
        event.remove(test_db.bind, "before_cursor_execute", record)
    assert (pending is None) == answered
    if not answered:
        assert pending.assistant_subtask_id == 7001
    assert not any(isinstance(row, Subtask) for row in test_db.identity_map.values())
    assert all("LIMIT" in sql for sql in statements)
    assert all(
        "subtasks.result AS" not in sql and "subtasks.prompt" not in sql
        for sql in statements
    )
    assert (
        list(store.iter_pending_form_candidates(test_db, task_id=701, owner_user_id=8))
        == []
    )


def test_form_candidate_pages_preserve_invalid_blocks_and_equal_message_order(
    test_db, monkeypatch
):
    seed(test_db)
    for row in test_db.query(Subtask).filter(Subtask.id <= 7120):
        row.message_id = 1
        row.result = {"blocks": _pending_form_blocks(valid=row.id == 7001)}
    test_db.commit()
    test_db.expunge_all()
    store = SqlAlchemySubtaskStore()
    monkeypatch.setattr(
        subtask_store,
        "iter_pending_form_candidates",
        store.iter_pending_form_candidates,
    )
    candidates = list(
        store.iter_pending_form_candidates(test_db, task_id=701, owner_user_id=7)
    )
    assert [row.id for row in candidates] == list(range(7120, 7000, -1))
    pending = get_pending_interactive_form(
        test_db, task_id=701, subscription_owner_user_id=7
    )
    assert pending is not None and pending.assistant_subtask_id == 7001
    user = test_db.get(Subtask, 7060)
    user.role = SubtaskRole.USER
    test_db.commit()
    assert (
        get_pending_interactive_form(test_db, task_id=701, subscription_owner_user_id=7)
        is None
    )


@pytest.mark.parametrize("limit", [None, 0, -1])
def test_history_pages_preserve_unlimited_and_empty_page_contracts(test_db, limit):
    seed(test_db)
    rows, total = SqlAlchemySubtaskStore().list_visible_history_page(
        test_db, task_id=701, owner_user_id=7, limit=limit, offset=100
    )
    assert total == 250
    assert [row.id for row in rows] == (
        list(range(7101, 7251)) if limit is None else []
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("subscription", [False, True])
async def test_completion_cleanup_marks_every_page_without_loading_payloads(
    test_db, monkeypatch, subscription
):
    from unittest.mock import AsyncMock, Mock

    from app.models.task import TaskResource
    from app.services.subscription import task_completion_handler as completion

    seed(test_db)
    task = test_db.get(TaskResource, 701)
    task.is_active = (
        TaskResource.STATE_SUBSCRIPTION if subscription else TaskResource.STATE_ACTIVE
    )
    test_db.commit()
    test_db.expunge_all()
    runtime = Mock()
    runtime.get_sandbox = AsyncMock(return_value=(None, None))
    executor = Mock()
    executor.delete_executor_task_async = AsyncMock()
    monkeypatch.setattr(completion, "get_executor_runtime_client", lambda: runtime)
    monkeypatch.setattr(completion, "executor_kinds_service", executor)
    store = SqlAlchemySubtaskStore()
    monkeypatch.setattr(
        subtask_store, "iter_runtime_cleanup_rows", store.iter_runtime_cleanup_rows
    )
    statements = []

    def record(_conn, _cursor, sql, *_args):
        if sql.lstrip().upper().startswith("SELECT") and "FROM subtasks" in sql:
            statements.append(sql)

    event.listen(test_db.bind, "before_cursor_execute", record)
    try:
        await completion.SubscriptionTaskCompletionHandler()._cleanup_task_runtime(
            test_db, 701, "bounded-cleanup-test"
        )
    finally:
        event.remove(test_db.bind, "before_cursor_execute", record)
    executor.delete_executor_task_async.assert_awaited_once_with(
        "executor-one", "default"
    )
    assert len(statements) == 8
    assert all("LIMIT" in sql for sql in statements)
    assert all(
        "subtasks.result" not in sql and "subtasks.prompt" not in sql
        for sql in statements
    )
    assert (
        test_db.query(Subtask.id)
        .filter(Subtask.task_id == 701, Subtask.executor_deleted_at == False)
        .count()
        == 0
    )
