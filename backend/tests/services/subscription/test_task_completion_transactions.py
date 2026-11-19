"""Completion durability and connection ownership across runtime cleanup."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import create_engine, event, select, update
from sqlalchemy.exc import DataError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

from app.core.events import TaskCompletedEvent
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.subscription import BackgroundExecutionStatus
from app.services.subscription.task_completion_handler import (
    SubscriptionTaskCompletionHandler,
)


@pytest.fixture
def completion_database(tmp_path, request):
    engine = create_engine(
        f"sqlite:///{tmp_path}/completion.sqlite",
        poolclass=QueuePool,
        pool_size=getattr(request, "param", 1),
        max_overflow=0,
        pool_timeout=0.2,
    )
    for model in (Kind, TaskResource, BackgroundExecution, Subtask):
        model.__table__.create(engine)
    factory = sessionmaker(engine, expire_on_commit=True)
    with factory() as db:
        db.add(
            Kind(
                id=2,
                user_id=1,
                kind="Subscription",
                name="completion-test",
                namespace="default",
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Subscription",
                    "metadata": {"name": "completion-test", "namespace": "default"},
                    "spec": {
                        "displayName": "Completion",
                        "taskType": "collection",
                        "trigger": {
                            "type": "interval",
                            "interval": {"value": 1, "unit": "hours"},
                        },
                        "teamRef": {"name": "completion-team", "namespace": "default"},
                        "promptTemplate": "completion",
                    },
                },
            )
        )
        db.add(TaskResource(id=44, user_id=1, kind="Task", name="completion", json={}))
        db.add(
            BackgroundExecution(
                id=98,
                user_id=1,
                subscription_id=2,
                task_id=44,
                inbox_message_id=9,
                trigger_type="manual",
                prompt="completion",
                status="RUNNING",
                version=0,
            )
        )
        db.commit()
    try:
        yield engine, factory
    finally:
        engine.dispose()


def completion_event(status="FAILED"):
    return TaskCompletedEvent(
        task_id=44,
        subtask_id=33,
        user_id=1,
        status=status,
        result={"value": "finished"},
        error="original execution failure" if status == "FAILED" else None,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["primary", "fallback", "competing"])
async def test_status_commit_exception_keeps_durable_outcome(completion_database, mode):
    engine, factory = completion_database
    handler = SubscriptionTaskCompletionHandler()
    faults = {"save": mode != "primary", "read": False, "read_failed": False}

    @event.listens_for(engine, "commit")
    def arm_post_commit_read(_connection):
        if mode != "competing" and not faults["read_failed"]:
            faults["read"] = True

    @event.listens_for(engine, "before_cursor_execute")
    def fail_at_transaction_boundary(
        _conn, _cursor, statement, params, _context, _many
    ):
        if statement.startswith("UPDATE background_executions") and faults["save"]:
            faults["save"] = False
            raise DataError(
                statement, params, ValueError("result exceeds column capacity")
            )
        if statement.startswith("SELECT") and faults["read"]:
            faults["read"] = False
            faults["read_failed"] = True
            raise RuntimeError("post-commit ORM read failed")

    @contextmanager
    def completion_session():
        with factory() as db:
            if mode == "competing":
                raced = False

                @event.listens_for(db, "after_soft_rollback")
                def advance_competing_writer(_session, _previous):
                    nonlocal raced
                    if not raced:
                        raced = True
                        with factory() as writer:
                            writer.execute(
                                update(BackgroundExecution)
                                .where(BackgroundExecution.id == 98)
                                .values(status="RUNNING", version=1)
                            )
                            writer.commit()

            yield db

    cleanup = AsyncMock()
    notify = AsyncMock()
    with (
        patch(
            "app.services.subscription.task_completion_handler.get_db_session",
            completion_session,
        ),
        patch("app.services.subscription.execution.emit_background_execution_update"),
        patch.object(handler, "_cleanup_finished_subscription_executor", cleanup),
        patch.object(handler, "_dispatch_notifications", notify),
        patch.object(handler, "_is_code_wiki_scheduled_update", return_value=False),
        patch(
            "app.services.inbox.result_writeback.write_execution_result_to_message"
        ) as inbox,
    ):
        await handler.on_task_completed(completion_event())

    event.remove(engine, "commit", arm_post_commit_read)
    event.remove(engine, "before_cursor_execute", fail_at_transaction_boundary)
    with factory() as db:
        execution = db.get(BackgroundExecution, 98)
        statistics = db.get(Kind, 2).json.get("status", {})
        if mode == "competing":
            assert execution.status == "RUNNING"
            assert execution.version == 1
            assert statistics.get("executionCount", 0) == 0
            cleanup.assert_not_awaited()
            notify.assert_not_awaited()
            inbox.assert_not_called()
            return
        assert faults["read_failed"]
        assert execution.status == "FAILED"
        assert execution.version == 1
        assert statistics["executionCount"] == 1
        assert statistics["failureCount"] == 1
        cause = execution.error_message
        if mode == "primary":
            assert cause == "original execution failure"
        else:
            assert "result exceeds column capacity" in cause
    cleanup.assert_awaited_once()
    notify.assert_awaited_once()
    assert notify.await_args.args[2].status == "FAILED"
    assert notify.await_args.args[2].error == cause
    inbox.assert_called_once()
    assert inbox.call_args.kwargs["error_message"] == cause


def runtime_row(row_id, executor_name, namespace="default"):
    return Subtask(
        id=row_id,
        task_id=44,
        user_id=1,
        team_id=1,
        title="completion",
        bot_ids=[],
        prompt="completion",
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.COMPLETED,
        executor_name=executor_name,
        executor_namespace=namespace,
        executor_deleted_at=False,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("completion_database", [2], indirect=True)
async def test_lost_cas_read_error_does_not_replay_another_callbacks_delivery(
    completion_database,
):
    engine, factory = completion_database
    handler = SubscriptionTaskCompletionHandler()
    gate = {"loser": None, "winner": False, "fail_read": False, "read_failed": False}

    @contextmanager
    def completion_session():
        with factory() as db:
            if gate["loser"] is None:
                gate["loser"] = db.connection()
            yield db

    with ThreadPoolExecutor(max_workers=1) as worker:

        @event.listens_for(engine, "before_cursor_execute")
        def win_before_losing_update(
            conn, _cursor, statement, _params, _context, _many
        ):
            if conn is not gate["loser"]:
                return
            if (
                statement.startswith("UPDATE background_executions")
                and not gate["winner"]
            ):
                gate["winner"] = True
                worker.submit(
                    asyncio.run, handler.on_task_completed(completion_event())
                ).result(timeout=3)
            elif statement.startswith("SELECT") and gate["fail_read"]:
                gate["fail_read"] = False
                gate["read_failed"] = True
                raise RuntimeError("lost-CAS refresh failed")

        @event.listens_for(engine, "after_cursor_execute")
        def fail_the_lost_cas_refresh(
            conn, _cursor, statement, _params, _context, _many
        ):
            if conn is gate["loser"] and statement.startswith(
                "UPDATE background_executions"
            ):
                gate["fail_read"] = not gate["read_failed"]

        cleanup = AsyncMock()
        notify = AsyncMock()
        with (
            patch(
                "app.services.subscription.task_completion_handler.get_db_session",
                completion_session,
            ),
            patch(
                "app.services.subscription.execution.emit_background_execution_update"
            ),
            patch.object(handler, "_cleanup_finished_subscription_executor", cleanup),
            patch.object(handler, "_dispatch_notifications", notify),
            patch.object(handler, "_is_code_wiki_scheduled_update", return_value=False),
            patch(
                "app.services.inbox.result_writeback.write_execution_result_to_message"
            ) as inbox,
        ):
            await handler.on_task_completed(completion_event())
        event.remove(engine, "before_cursor_execute", win_before_losing_update)
        event.remove(engine, "after_cursor_execute", fail_the_lost_cas_refresh)

    assert gate["winner"] and gate["read_failed"]
    with factory() as db:
        execution = db.get(BackgroundExecution, 98)
        statistics = db.get(Kind, 2).json["status"]
        assert execution.status == "FAILED" and execution.version == 1
        assert execution.error_message == "original execution failure"
        assert statistics["executionCount"] == 1
        assert statistics["failureCount"] == 1
    notify.assert_awaited_once()
    inbox.assert_called_once()


@pytest.mark.asyncio
async def test_http_cleanup_releases_connection_and_marks_only_prepared_bindings(
    completion_database,
):
    _engine, factory = completion_database
    with factory() as db:
        db.add_all(
            [
                runtime_row(31, "executor-a"),
                runtime_row(32, "executor-c"),
                runtime_row(34, "executor-d", None),
                runtime_row(35, "executor-d", ""),
            ]
        )
        db.commit()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def delayed_delete(*_args):
        entered.set()
        await release.wait()
        return {"status": "success"}

    runtime = MagicMock()
    runtime.get_sandbox = AsyncMock(return_value=(None, None))
    handler = SubscriptionTaskCompletionHandler()
    with (
        patch(
            "app.services.subscription.task_completion_handler.get_executor_runtime_client",
            return_value=runtime,
        ),
        patch(
            "app.services.subscription.task_completion_handler.executor_kinds_service.delete_executor_task_async",
            side_effect=delayed_delete,
        ),
    ):
        with factory() as db:
            operation = asyncio.create_task(
                handler._cleanup_task_runtime(db, 44, "test")
            )
            try:
                await asyncio.wait_for(entered.wait(), timeout=2)
                with factory() as writer:
                    rows = writer.scalars(select(Subtask).order_by(Subtask.id)).all()
                    assert all(not row.executor_deleted_at for row in rows)
                    writer.get(Subtask, 31).executor_name = "rebound-executor"
                    writer.get(Subtask, 34).executor_namespace = ""
                    writer.add(runtime_row(36, "executor-a"))
                    writer.commit()
                release.set()
                await asyncio.wait_for(operation, timeout=2)
            finally:
                release.set()
                await operation
    with factory() as db:
        flags = {row.id: row.executor_deleted_at for row in db.scalars(select(Subtask))}
    assert flags == {31: False, 32: True, 34: False, 35: True, 36: False}


from tests.services.subscription.test_task_completion_handler import (
    _finished_subscription_fixture,
    _mocked_session,
)


def _result_save_fixture(update_side_effect):
    """A RUNNING execution whose completion update is driven by update_side_effect."""
    from app.core.events import TaskCompletedEvent
    from app.services.subscription.task_completion_handler import (
        SubscriptionTaskCompletionHandler,
    )

    handler = SubscriptionTaskCompletionHandler()
    execution = SimpleNamespace(
        id=98,
        subscription_id=21801,
        status=BackgroundExecutionStatus.RUNNING.value,
        inbox_message_id=0,
    )
    db = _mocked_session()

    @contextmanager
    def fake_db_session():
        yield db

    event = TaskCompletedEvent(
        task_id=44,
        subtask_id=33,
        user_id=1,
        status="COMPLETED",
        result={"value": "x" * 70000},
        error=None,
    )
    dispatch = AsyncMock()
    cleanup = AsyncMock()
    patches = (
        patch.object(handler, "_find_execution_by_task_id", return_value=execution),
        patch.object(handler, "_extract_result_summary", return_value="x" * 70000),
        patch.object(handler, "_dispatch_notifications", new=dispatch),
        patch.object(
            handler.execution_manager,
            "update_execution_status",
            side_effect=update_side_effect,
        ),
        patch(
            "app.services.subscription.task_completion_handler.get_db_session",
            fake_db_session,
        ),
        patch.object(handler, "_cleanup_finished_subscription_executor", new=cleanup),
    )
    return handler, event, db, dispatch, patches


@pytest.mark.parametrize("event_status", ["COMPLETED", "FAILED"])
@pytest.mark.asyncio
async def test_cleanup_commit_failure_still_writes_inbox_and_notifies(
    event_status: str,
) -> None:
    """A failed cleanup commit must roll back before required result delivery."""
    handler, event, db, _, dispatch, patches = _finished_subscription_fixture(
        event_status=event_status,
        execution_status=BackgroundExecutionStatus.RUNNING.value,
    )
    lifecycle = []

    def fail_cleanup_commit() -> None:
        if not lifecycle:
            lifecycle.append("prepared")
            return
        lifecycle.append("cleanup commit")
        raise RuntimeError("cleanup commit failed")

    def writeback(*args: Any, **kwargs: Any) -> None:
        assert lifecycle == ["prepared", "cleanup commit", "rollback"]
        lifecycle.append("inbox")

    async def notify(*args: Any, **kwargs: Any) -> None:
        assert lifecycle == ["prepared", "cleanup commit", "rollback", "inbox"]
        lifecycle.append("notifications")

    db.commit.side_effect = fail_cleanup_commit
    db.rollback.side_effect = lambda: lifecycle.append("rollback")
    dispatch.side_effect = notify
    with (
        patches[0] as find,
        patches[1],
        patches[2],
        patches[3] as update,
        patches[4],
        patches[5],
        patches[6] as runtime_client_factory,
        patches[7] as executor_service,
        patch.object(handler, "_is_code_wiki_scheduled_update", return_value=False),
        patch(
            "app.services.inbox.result_writeback.write_execution_result_to_message",
            side_effect=writeback,
        ) as write_result,
    ):
        find.return_value.inbox_message_id = 7
        runtime_client = MagicMock()
        runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        runtime_client_factory.return_value = runtime_client
        executor_service.delete_executor_task_async = AsyncMock(
            return_value={"status": "success"}
        )
        await handler.on_task_completed(event)

    assert lifecycle == [
        "prepared",
        "cleanup commit",
        "rollback",
        "inbox",
        "notifications",
    ]
    db.rollback.assert_called_once()
    write_result.assert_called_once()
    assert write_result.call_args.kwargs["status"] == event_status
    dispatch.assert_awaited_once()
    assert update.call_count == 1


def _data_too_long():
    from sqlalchemy.exc import DataError

    class MySQLDataError(Exception):
        def __str__(self):
            return "(1406, \"Data too long for column 'result_summary' at row 1\")"

    return DataError("UPDATE background_executions ...", {}, MySQLDataError())


@pytest.mark.asyncio
async def test_unsaveable_result_fails_execution_and_still_notifies():
    """A result the DB rejects must fail the run with the cause, not leave it RUNNING."""
    handler, event, db, dispatch, patches = _result_save_fixture(
        [_data_too_long(), True]
    )

    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3] as update,
        patches[4],
        patches[5] as cleanup,
    ):
        await handler.on_task_completed(event)

    db.rollback.assert_called_once()
    assert update.call_count == 2
    fallback = update.call_args_list[1].kwargs
    assert fallback["status"] == BackgroundExecutionStatus.FAILED
    assert fallback["skip_notifications"] is True
    assert "result_summary" not in fallback
    assert fallback["error_message"].startswith(
        "The run finished but its result could not be saved: MySQLDataError: (1406"
    )

    dispatch.assert_awaited_once()
    sent_event = dispatch.await_args.args[2]
    assert sent_event.status == "FAILED"
    assert sent_event.error == fallback["error_message"]
    assert dispatch.await_args.args[3] == "x" * 70000
    cleanup.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("fallback", [False, True])
@pytest.mark.parametrize("stored_status", ["CANCELLED", "RUNNING"])
async def test_status_noop_releases_only_a_persisted_terminal_execution(
    fallback: bool, stored_status: str
) -> None:
    """A lost write may observe a cancelled run or a still-active competing writer."""
    handler, event, db, dispatch, patches = _result_save_fixture(
        [_data_too_long(), False] if fallback else [False]
    )
    db.refresh.side_effect = lambda execution: setattr(
        execution, "status", stored_status
    )

    with (
        patches[0],
        patches[1],
        patches[2],
        patches[3] as update,
        patches[4],
        patches[5] as cleanup,
    ):
        await handler.on_task_completed(event)

    assert update.call_count == (2 if fallback and stored_status == "RUNNING" else 1)
    assert db.rollback.call_count == (2 if fallback else 1)
    assert db.refresh.call_count == (2 if fallback else 1)
    if stored_status == "CANCELLED":
        cleanup.assert_awaited_once()
    else:
        cleanup.assert_not_awaited()
    dispatch.assert_not_awaited()
