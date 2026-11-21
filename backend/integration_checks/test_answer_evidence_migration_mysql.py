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
from app.models.task import TaskResource
from app.services.chat.storage import db as storage

HEAD = "c6e8a1d4f902"
PREVIOUS = "f3a7c9e1b2d4"


@pytest.fixture
def database(monkeypatch):
    url = make_url(os.environ["ANSWER_EVIDENCE_MYSQL_TEST_URL"])
    assert url.get_backend_name() == "mysql"
    assert url.host in {"127.0.0.1", "localhost"}
    assert url.database == "plugin_auth_test" and url.password == "plugin_auth_test"
    schema = f"answer_evidence_test_{uuid4().hex}"
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
            "_update_task_status_in_session",
            lambda *a, **k: storage.TaskStatusUpdateResult(),
        )
        yield engine, config
    finally:
        if engine:
            engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f"DROP DATABASE `{schema}`")
        admin.dispose()


def answer(db, *, status=SubtaskStatus.RUNNING):
    if db.get(TaskResource, 9) is None:
        db.add(
            TaskResource(
                id=9,
                user_id=7,
                kind="Task",
                name="answer-evidence",
                namespace="default",
                json={"status": {"status": "RUNNING"}},
            )
        )
        db.flush()
    row = Subtask(
        user_id=7,
        task_id=9,
        team_id=1,
        title="answer",
        bot_ids=[],
        status=status,
    )
    db.add(row)
    db.commit()
    return row.id


def test_python_startup_upgrade_rollback_reupgrade_preserves_old_data(database):
    engine, config = database
    with Session(engine) as db:
        answer_id = answer(db, status=SubtaskStatus.COMPLETED)
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
    head_columns, head_indexes = subtask_schema(engine)
    assert "answer_generation_id" not in head_columns
    assert "ix_subtasks_task_id" not in head_indexes
    command.downgrade(config, PREVIOUS)
    assert subtask_schema(engine) == (head_columns, head_indexes)
    assert "knowledge_citations" not in sa.inspect(engine).get_table_names()
    with Session(engine) as db:
        assert db.get(Subtask, answer_id).title == "answer"
    command.upgrade(config, "head")
    assert subtask_schema(engine) == (head_columns, head_indexes)
    with Session(engine) as db:
        assert db.get(Subtask, answer_id).title == "answer"
        assert db.get(KnowledgeDocument, document_id).chunks == [
            {"content": "original"}
        ]
        assert db.query(KnowledgeCitation).count() == 0
        assert (
            db.execute(sa.text("SELECT version_num FROM alembic_version")).scalar_one()
            == HEAD
        )


def subtask_schema(engine):
    inspector = sa.inspect(engine)
    return (
        {column["name"] for column in inspector.get_columns("subtasks")},
        {index["name"] for index in inspector.get_indexes("subtasks")},
    )
