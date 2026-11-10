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
