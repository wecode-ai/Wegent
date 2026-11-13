# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""CI-only, isolated MySQL answer commit and migration contract checks."""

import os
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from alembic import command
from alembic.config import Config
from app.core.config import settings
from app.models.knowledge import KnowledgeDocument
from app.models.knowledge_citation import KnowledgeCitation
from app.models.subtask import Subtask, SubtaskStatus
from app.services.chat.operations.retry import reset_subtask_for_retry
from app.services.chat.storage import db as storage
from app.services.chat.storage.answer_attempt import AnswerSaveResult
from app.services.chat.trigger.lifecycle import persist_completed_result
from app.stores.tasks import subtask_store

HEAD = "a91e7c42d803"
PREVIOUS = "f3a7c9e1b2d4"


@pytest.fixture
def database(monkeypatch):
    url = make_url(os.environ["ANSWER_ATTEMPT_MYSQL_TEST_URL"])
    assert url.get_backend_name() == "mysql"
    assert url.host in {"127.0.0.1", "localhost"}
    assert url.database == "plugin_auth_test" and url.password == "plugin_auth_test"
    schema = f"answer_attempt_test_{uuid4().hex}"
    admin = sa.create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(
                f"CREATE DATABASE `{schema}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        test_url = url.set(database=schema)
        monkeypatch.setattr(
            settings, "DATABASE_URL", test_url.render_as_string(hide_password=False)
        )
        config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
        command.upgrade(config, "head")
        engine = sa.create_engine(test_url, isolation_level="REPEATABLE READ")

        @contextmanager
        def session():
            with Session(engine) as db:
                try:
                    yield db
                    db.commit()
                except Exception:
                    db.rollback()
                    raise

        monkeypatch.setattr(storage, "_db_session", session)
        monkeypatch.setattr("app.db.session.SessionLocal", lambda: Session(engine))
        monkeypatch.setattr(
            "app.services.chat.trigger.lifecycle.SessionLocal", lambda: Session(engine)
        )
        # This suite isolates answer persistence; task projections have separate tests.
        monkeypatch.setattr(
            storage.db_handler,
            "_update_task_status_sync",
            lambda *a, **k: storage.TaskStatusUpdateResult(),
        )
        yield engine, config
    finally:
        if engine:
            engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f"DROP DATABASE `{schema}`")
        admin.dispose()


def answer(db, *, identity="a" * 32, status=SubtaskStatus.RUNNING):
    row = Subtask(
        user_id=7,
        task_id=9,
        team_id=1,
        title="answer",
        bot_ids=[],
        status=status,
        answer_generation_id=identity,
    )
    db.add(row)
    db.commit()
    return row.id


def test_python_startup_upgrade_rollback_reupgrade_preserves_old_data(database):
    engine, config = database
    with Session(engine) as db:
        answer_id = answer(db, identity=None, status=SubtaskStatus.COMPLETED)
        document = KnowledgeDocument(
            kind_id=1,
            user_id=7,
            name="old document",
            file_extension="txt",
            chunks=[{"content": "original"}],
        )
        db.add(document)
        db.add(
            KnowledgeCitation(
                knowledge_base_id=1,
                document_id=1,
                user_id=7,
                title="snapshot",
                content="片" * 5000,
                caller_context={
                    "answer_evidence": {
                        "answer_id": str(answer_id),
                        "generation_id": "a" * 32,
                        "local_id": "e1",
                    }
                },
            )
        )
        db.commit()
        document_id = document.id
    command.downgrade(config, PREVIOUS)
    assert "ix_subtasks_task_id" not in {
        index["name"] for index in sa.inspect(engine).get_indexes("subtasks")
    }
    assert "knowledge_citations" not in sa.inspect(engine).get_table_names()
    assert "answer_generation_id" not in {
        c["name"] for c in sa.inspect(engine).get_columns("subtasks")
    }
    with engine.connect() as connection:
        assert (
            connection.scalar(
                sa.text("SELECT title FROM subtasks WHERE id=:id"), {"id": answer_id}
            )
            == "answer"
        )
    command.upgrade(config, "head")
    command.upgrade(config, "head")
    assert "ix_subtasks_task_id" in {
        index["name"] for index in sa.inspect(engine).get_indexes("subtasks")
    }
    with Session(engine) as db:
        assert db.get(Subtask, answer_id).answer_generation_id is None
        assert db.get(KnowledgeDocument, document_id).chunks == [
            {"content": "original"}
        ]
        assert db.query(KnowledgeCitation).count() == 0
        assert (
            db.execute(sa.text("SELECT version_num FROM alembic_version")).scalar_one()
            == HEAD
        )


@pytest.mark.parametrize("committed_retry", [True, False])
def test_read_committed_rechecks_attempts_around_the_task_lock(
    database, monkeypatch, committed_retry
):
    """RC retries must survive the scan/Task-lock gap without reverse waiting."""
    from fastapi import HTTPException

    from app.models.task import TaskResource
    from app.services.chat.operations.cancel import finalize_empty_cancellation
    from tests.services.chat.operations.test_cancel_stuck import _task_json

    engine, _ = database
    with Session(engine) as db:
        db.add(
            TaskResource(
                id=9,
                user_id=7,
                kind="Task",
                name="rc-cancel",
                namespace="default",
                json=_task_json("RUNNING"),
            )
        )
        answer_id = answer(db, status=SubtaskStatus.CANCELLED)
    rc_engine = engine.execution_options(isolation_level="READ COMMITTED")
    failures = []

    def capture_failure(context):
        failures.append(context.original_exception.args[0])

    sa.event.listen(engine, "handle_error", capture_failure)
    with Session(rc_engine) as reader, Session(engine) as writer:
        refresh = reader.refresh
        reader.execute(sa.text("SET SESSION innodb_lock_wait_timeout=1"))

        def commit_retry_before_lock(task, **kwargs):
            if committed_retry:
                reset_subtask_for_retry(
                    writer, writer.get(Subtask, answer_id), writer.get(TaskResource, 9)
                )
            refresh(task, **kwargs)
            if not committed_retry:
                # Retry owns the answer lock but has not acquired the Task lock.
                writer.execute(
                    sa.update(Subtask)
                    .where(Subtask.id == answer_id)
                    .values(status=SubtaskStatus.PENDING, answer_generation_id="b" * 32)
                )

        monkeypatch.setattr(reader, "refresh", commit_retry_before_lock)
        if committed_retry:
            assert not finalize_empty_cancellation(reader, task_id=9, user_id=7)
        else:
            with pytest.raises(HTTPException) as rejected:
                finalize_empty_cancellation(reader, task_id=9, user_id=7)
            assert rejected.value.status_code == 503
            assert failures == [3572]  # ER_LOCK_NOWAIT, not the lock-wait timeout.
            writer.rollback()
    sa.event.remove(engine, "handle_error", capture_failure)
    with Session(engine) as db:
        if committed_retry:
            assert db.get(Subtask, answer_id).status == SubtaskStatus.PENDING
            assert db.get(Subtask, answer_id).answer_generation_id != "a" * 32
            assert db.get(TaskResource, 9).json["status"]["status"] == "PENDING"
        else:
            assert db.get(Subtask, answer_id).status == SubtaskStatus.CANCELLED
            assert db.get(TaskResource, 9).json["status"]["status"] == "RUNNING"


def test_task_locking_read_does_not_block_other_existing_tasks(database):
    """An empty task-range lock must leave another task's existing row writable."""
    engine, _ = database
    with Session(engine) as db:
        answer(db, status=SubtaskStatus.CANCELLED)
        other_id = answer(db)
        db.get(Subtask, other_id).task_id = 10
        db.commit()

    with Session(engine) as first, Session(engine) as other:
        captured = []
        connection = first.connection()

        def capture(_connection, _cursor, statement, parameters, _context, _many):
            captured.append((statement, parameters))

        sa.event.listen(connection, "before_cursor_execute", capture)
        active = subtask_store.list_by_task_statuses(
            first,
            task_id=9,
            statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
            for_update=True,
        )
        sa.event.remove(connection, "before_cursor_execute", capture)
        assert active == []
        statement, parameters = captured[-1]
        plan = (
            connection.exec_driver_sql("EXPLAIN " + statement, parameters)
            .mappings()
            .one()
        )
        assert plan["key"] == "ix_subtasks_task_id"
        assert plan["type"] != "ALL"
        other.execute(sa.text("SET SESSION innodb_lock_wait_timeout=1"))
        other.execute(
            sa.update(Subtask).where(Subtask.id == other_id).values(progress=42)
        )
        other.commit()
        first.rollback()
    with Session(engine) as db:
        assert db.get(Subtask, other_id).progress == 42


@pytest.mark.asyncio
@pytest.mark.parametrize("late_status", ["COMPLETED", "FAILED", "CANCELLED"])
async def test_old_terminal_and_null_writer_cannot_replace_retry(database, late_status):
    engine, _ = database
    with Session(engine) as old, Session(engine) as retry:
        answer_id = answer(old, status=SubtaskStatus.FAILED)
        stale = old.get(Subtask, answer_id)
        current = retry.get(Subtask, answer_id)
        generation = reset_subtask_for_retry(retry, current)
        assert generation != stale.answer_generation_id
        # The stale RR identity map must not authorize a second retry.
        with pytest.raises(ValueError):
            reset_subtask_for_retry(old, stale)
        saved = await storage.db_handler.update_subtask_status(
            answer_id, "RUNNING", expected_status="PENDING", generation_id=generation
        )
        assert saved is AnswerSaveResult.COMMITTED
    for identity in ("a" * 32, None):
        saved = await persist_completed_result(
            subtask_id=answer_id,
            task_id=9,
            status=late_status,
            result={"value": "old"},
            expected_status="RUNNING",
            generation_id=identity,
        )
        assert saved is AnswerSaveResult.REJECTED
    with Session(engine) as db:
        assert db.get(Subtask, answer_id).status == SubtaskStatus.RUNNING
        assert db.get(Subtask, answer_id).answer_generation_id == generation


@pytest.mark.asyncio
async def test_completion_cancel_competition_and_duplicate_completion(database):
    import asyncio

    engine, _ = database
    with Session(engine) as db:
        answer_id = answer(db)
    saved = await asyncio.gather(
        *[
            storage.db_handler.update_subtask_status(
                answer_id,
                state,
                result={"value": state},
                expected_status="RUNNING",
                generation_id="a" * 32,
            )
            for state in ("COMPLETED", "CANCELLED")
        ]
    )
    assert saved.count(AnswerSaveResult.COMMITTED) == 1
    assert saved.count(AnswerSaveResult.REJECTED) == 1
    assert (
        await storage.db_handler.update_subtask_status(
            answer_id, "COMPLETED", expected_status="RUNNING", generation_id="a" * 32
        )
        is AnswerSaveResult.REJECTED
    )


@pytest.mark.asyncio
async def test_real_mysql_update_failure_is_not_completion(database):
    engine, _ = database
    with Session(engine) as db:
        answer_id = answer(db)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TRIGGER reject_answer BEFORE UPDATE ON subtasks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='answer update rejected'"
        )
    saved = await storage.db_handler.update_subtask_status(
        answer_id,
        "COMPLETED",
        result={"value": "unsaved"},
        expected_status="RUNNING",
        generation_id="a" * 32,
    )
    assert saved is AnswerSaveResult.UNCONFIRMED
    with Session(engine) as db:
        assert db.get(Subtask, answer_id).status == SubtaskStatus.RUNNING
        assert db.get(Subtask, answer_id).result is None


@pytest.mark.asyncio
async def test_commit_connection_loss_is_explicitly_unconfirmed(database):
    engine, _ = database
    with Session(engine) as db:
        answer_id = answer(db)
    killer = sa.create_engine(engine.url, isolation_level="AUTOCOMMIT")

    def kill_before_commit(connection):
        connection_id = connection.connection.driver_connection.thread_id()
        with killer.connect() as control:
            control.exec_driver_sql(f"KILL CONNECTION {int(connection_id)}")

    sa.event.listen(engine, "commit", kill_before_commit)
    try:
        saved = await storage.db_handler.update_subtask_status(
            answer_id,
            "COMPLETED",
            result={"value": "uncertain"},
            expected_status="RUNNING",
            generation_id="a" * 32,
        )
        assert saved is AnswerSaveResult.UNCONFIRMED
    finally:
        sa.event.remove(engine, "commit", kill_before_commit)
        killer.dispose()


@pytest.mark.asyncio
async def test_scanned_attempt_cannot_fail_retried_answer(database, monkeypatch):
    from datetime import datetime, timedelta
    from unittest.mock import AsyncMock

    from app.services.execution import stalled_tasks

    engine, _ = database
    with Session(engine) as db:
        answer_id = answer(db)
        scanned = stalled_tasks.StalledCandidate(
            task_id=9,
            subtask_id=answer_id,
            user_id=7,
            executor_name="",
            executor_namespace="",
            updated_at=datetime.now() - timedelta(hours=1),
            answer_generation_id="a" * 32,
        )
    assert await storage.db_handler.update_subtask_status(
        answer_id, "FAILED", generation_id="a" * 32
    )
    with Session(engine) as db:
        generation = reset_subtask_for_retry(db, db.get(Subtask, answer_id))
    assert await storage.db_handler.update_subtask_status(
        answer_id, "RUNNING", generation_id=generation, expected_status="PENDING"
    )
    monkeypatch.setattr("app.db.session.SessionLocal", lambda: Session(engine))
    # Redis and event delivery are external boundaries; SQL and completion remain real.
    session_manager = AsyncMock()
    session_manager.get_accumulated_content.return_value = ""
    session_manager.finalize_and_get_blocks.return_value = []
    monkeypatch.setattr("app.services.chat.storage.session_manager", session_manager)
    delivered = AsyncMock()
    monkeypatch.setattr(stalled_tasks, "WebSocketResultEmitter", lambda **_: delivered)
    assert not await stalled_tasks.fail_stalled_subtask(
        scanned, error_message="old scan", error_code="executor_not_started"
    )
    delivered.emit.assert_not_awaited()
    session_manager.cleanup_streaming_state.assert_not_awaited()
    with Session(engine) as db:
        current = db.get(Subtask, answer_id)
        assert current.status == SubtaskStatus.RUNNING
        assert current.answer_generation_id == generation


@pytest.mark.asyncio
async def test_repeatable_read_identity_map_cannot_authorize_old_writer(
    database, monkeypatch
):
    engine, _ = database
    with Session(engine) as stale_session, Session(engine) as retry_session:
        answer_id = answer(stale_session, status=SubtaskStatus.FAILED)
        stale = stale_session.get(Subtask, answer_id)
        assert stale.answer_generation_id == "a" * 32
        generation = reset_subtask_for_retry(
            retry_session, retry_session.get(Subtask, answer_id)
        )
        assert await storage.db_handler.update_subtask_status(
            answer_id, "RUNNING", generation_id=generation, expected_status="PENDING"
        )

        @contextmanager
        def stale_database_session():
            yield stale_session
            stale_session.commit()

        monkeypatch.setattr(storage, "_db_session", stale_database_session)
        saved = await storage.db_handler.update_subtask_status(
            answer_id,
            "COMPLETED",
            result={"value": "late"},
            generation_id="a" * 32,
            expected_status="RUNNING",
        )
        assert saved is AnswerSaveResult.REJECTED
        # The locking read sees B, but it must never adopt B's identity for A.
        assert stale.answer_generation_id == generation
    with Session(engine) as db:
        assert db.get(Subtask, answer_id).status == SubtaskStatus.RUNNING
        assert db.get(Subtask, answer_id).result is None


@pytest.mark.asyncio
async def test_preparation_failure_can_finish_pending_but_not_retried_attempt(database):
    engine, _ = database
    with Session(engine) as db:
        answer_id = answer(db, status=SubtaskStatus.PENDING)
    assert (
        await storage.db_handler.update_subtask_status(
            answer_id, "FAILED", generation_id="a" * 32, expected_status="PENDING"
        )
        is AnswerSaveResult.COMMITTED
    )
    with Session(engine) as db:
        generation = reset_subtask_for_retry(db, db.get(Subtask, answer_id))
    assert (
        await storage.db_handler.update_subtask_status(
            answer_id, "FAILED", generation_id="a" * 32, expected_status="PENDING"
        )
        is AnswerSaveResult.REJECTED
    )
    with Session(engine) as db:
        current = db.get(Subtask, answer_id)
        assert current.status == SubtaskStatus.PENDING
        assert current.answer_generation_id == generation


@pytest.mark.asyncio
@pytest.mark.parametrize("task_status", ["RUNNING", "CANCELLING"])
@pytest.mark.parametrize("retry_after_capture", [False, True])
@pytest.mark.parametrize("initially_active", [False, True])
async def test_rest_cancel_keeps_request_attempt_on_real_mysql(
    database, monkeypatch, task_status, retry_after_capture, initially_active
):
    from copy import deepcopy
    from datetime import datetime, timedelta
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock

    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.api.dependencies import get_db
    from app.api.endpoints.adapter import tasks as task_api
    from app.core import security
    from app.models.task import TaskResource
    from app.models.user import User
    from app.services.chat.operations import cancel as cancel_ops

    engine, _ = database
    payload = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": "cancel-test",
            "namespace": "default",
            "labels": {"source": "chat_shell"},
        },
        "spec": {
            "title": "cancel test",
            "prompt": "p",
            "teamRef": {"name": "team", "namespace": "default"},
            "workspaceRef": {"name": "ws", "namespace": "default"},
        },
        "status": {
            "status": task_status,
            "progress": 0,
            "updatedAt": (datetime.now() - timedelta(hours=1)).isoformat(),
        },
    }
    with Session(engine) as db:
        db.add(User(id=7, user_name="cancel-owner", password_hash="unused-test-hash"))
        db.add(
            TaskResource(
                id=9,
                user_id=7,
                kind="Task",
                name="cancel-test",
                namespace="default",
                json=payload,
            )
        )
        answer_id = answer(
            db,
            status=(
                SubtaskStatus.RUNNING if initially_active else SubtaskStatus.CANCELLED
            ),
        )
        subtask = db.get(Subtask, answer_id)
        subtask.result = {"value": "A"}
        subtask.bot_ids = []
        db.commit()

    capture = cancel_ops.capture_cancellation_attempts
    observed = {}

    def capture_then_retry(db, *, task_id):
        attempts = capture(db, task_id=task_id)
        observed["attempts"] = dict(attempts)
        if retry_after_capture:
            # Independent RR sessions establish A -> terminal -> B before the
            # original HTTP request attempts its conditional cancellation.
            with Session(engine) as retry_db:
                old = retry_db.get(Subtask, answer_id)
                if initially_active:
                    assert subtask_store.update_fields_if_attempt(
                        retry_db,
                        subtask=old,
                        generation_id="a" * 32,
                        from_statuses=(SubtaskStatus.RUNNING,),
                        status=SubtaskStatus.FAILED,
                    )
                    retry_db.commit()
                generation = reset_subtask_for_retry(
                    retry_db, old, retry_db.get(TaskResource, task_id)
                )
                assert subtask_store.update_fields_if_attempt(
                    retry_db,
                    subtask=old,
                    generation_id=generation,
                    from_statuses=(SubtaskStatus.PENDING,),
                    status=SubtaskStatus.RUNNING,
                    result={"value": "B"},
                )
                task = retry_db.get(TaskResource, task_id)
                current_payload = deepcopy(task.json)
                current_payload["status"]["status"] = "RUNNING"
                task.json = current_payload
                retry_db.commit()
                observed["new_identity"] = generation
        return attempts

    monkeypatch.setattr(cancel_ops, "capture_cancellation_attempts", capture_then_retry)
    signal = MagicMock(return_value=True)
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager.cancel_stream_from_sync", signal
    )
    publish = AsyncMock()
    monkeypatch.setattr(cancel_ops, "publish_task_cancelled_events", publish)
    app = FastAPI()
    app.include_router(task_api.router, prefix="/tasks")

    async def request_database():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_db] = request_database
    app.dependency_overrides[security.get_current_user] = lambda: SimpleNamespace(id=7)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post("/tasks/9/cancel")

    assert observed["attempts"] == ({answer_id: "a" * 32} if initially_active else {})
    with Session(engine) as db:
        current = db.get(Subtask, answer_id)
        task = db.get(TaskResource, 9)
        if retry_after_capture:
            assert response.status_code == 409
            assert current.status == SubtaskStatus.RUNNING
            assert current.answer_generation_id == observed["new_identity"]
            assert current.result == {"value": "B"}
            assert task.json["status"]["status"] == "RUNNING"
            signal.assert_not_called()
            publish.assert_not_awaited()
        else:
            assert response.status_code == 200, response.text
            assert response.json()["status"] == "CANCELLED"
            assert current.status == SubtaskStatus.CANCELLED
            assert current.answer_generation_id == "a" * 32
            assert task.json["status"]["status"] == "CANCELLED"
            if not initially_active:
                signal.assert_not_called()
                publish.assert_not_awaited()
            elif task_status == "RUNNING":
                assert current.result == {"value": "A"}
                assert signal.call_count == 1
                assert signal.call_args.args[0] == answer_id
                publish.assert_not_awaited()
            else:
                signal.assert_not_called()
                publish.assert_awaited_once_with(9, [answer_id], 7)


@pytest.mark.asyncio
async def test_rest_cancel_row_lock_excludes_retry_until_signal_publication(
    database, monkeypatch
):
    import asyncio
    from threading import Event

    from app.services.adapters.task_kinds.operations import TaskOperationsMixin
    from app.services.chat.storage import session_manager

    engine, _ = database
    with Session(engine) as db:
        answer_id = answer(db, status=SubtaskStatus.CANCELLED)
    signal_entered = Event()
    release_signal = Event()
    order = []

    def publish(key, value, *, expire):
        assert key == f"chat:cancel:{answer_id}"
        assert value is True and expire == 300
        signal_entered.set()
        assert release_signal.wait(10), "test did not release cancellation publication"
        order.append("signal")
        return True

    monkeypatch.setattr(session_manager._cache, "set_from_sync", publish)
    service = object.__new__(TaskOperationsMixin)
    callback = asyncio.create_task(service._call_chat_shell_cancel(answer_id, "a" * 32))

    def retry_while_signal_is_pending():
        with Session(engine) as db:
            db.execute(sa.text("SET SESSION innodb_lock_wait_timeout=1"))
            return reset_subtask_for_retry(db, db.get(Subtask, answer_id))

    try:
        assert await asyncio.to_thread(signal_entered.wait, 10)
        # Exercise the real retry UPDATE after the callback's identity check,
        # before publication. It cannot change identity while that row is locked.
        with pytest.raises(sa.exc.OperationalError) as blocked:
            await asyncio.to_thread(retry_while_signal_is_pending)
        assert blocked.value.orig.args[0] == 1205
        with Session(engine) as db:
            assert db.get(Subtask, answer_id).answer_generation_id == "a" * 32
    finally:
        release_signal.set()
        await callback
    with Session(engine) as db:
        generation = reset_subtask_for_retry(db, db.get(Subtask, answer_id))
        order.append("retry")
        assert generation != "a" * 32
    assert order == ["signal", "retry"]
