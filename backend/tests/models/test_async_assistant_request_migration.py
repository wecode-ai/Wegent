"""Large accepted request history survives upgrades and application rollback."""

import importlib.util
import json
from io import StringIO
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.dialects import mysql, sqlite

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.core.config import settings
from app.models.loop_item_execution import LoopItemExecution


def load_migration(operations: Operations):
    path = (
        Path(__file__).parents[3]
        / "backend-rs/migrations/reference/versions"
        / "20261117_c7d8e9f0a1b2_expand_assistant_request_payload.py"
    )
    spec = importlib.util.spec_from_file_location("assistant_request_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    migration.op = operations
    return migration


def test_mysql_payload_widening_and_rollback_preserve_accepted_data():
    output = StringIO()
    operations = Operations(
        MigrationContext.configure(
            dialect_name="mysql", opts={"as_sql": True, "output_buffer": output}
        )
    )
    migration = load_migration(operations)
    migration.upgrade()
    assert output.getvalue().strip() == (
        "ALTER TABLE loop_item_executions MODIFY execution_payload LONGTEXT NOT NULL;"
    )
    output.seek(0)
    output.truncate()
    migration.downgrade()
    assert output.getvalue() == ""
    column = LoopItemExecution.__table__.c.execution_payload
    assert column.type.compile(dialect=mysql.dialect()) == "LONGTEXT"
    assert column.type.compile(dialect=sqlite.dialect()) == "TEXT"
    native = json.loads(
        (
            Path(__file__).parents[3]
            / "backend-rs/migrations/revisions/c7d8e9f0a1b2.json"
        ).read_text()
    )
    assert native["downgrade"] == []
    assert native["parents"] == [migration.down_revision]


def test_real_alembic_upgrade_head_and_downgrade_preserve_large_history(
    tmp_path, monkeypatch
):
    url = f"sqlite:///{(tmp_path / 'assistant-requests.sqlite').as_posix()}"
    monkeypatch.setattr(settings, "DATABASE_URL", url)
    config = Config("alembic.ini")
    engine = sa.create_engine(url)
    with engine.begin() as connection:
        connection.execute(sa.text("CREATE TABLE alembic_version (version_num TEXT)"))
        connection.execute(
            sa.text("INSERT INTO alembic_version VALUES ('b1c2d3e4f5a6')")
        )
        connection.execute(
            sa.text(
                "CREATE TABLE loop_item_executions (execution_payload TEXT NOT NULL)"
            )
        )
        payload = json.dumps({"commands": ["more detail" * 1000] * 10})
        assert len(payload.encode()) > 65535
        connection.execute(
            sa.text("INSERT INTO loop_item_executions VALUES (:payload)"),
            {"payload": payload},
        )
    command.upgrade(config, "head")
    command.downgrade(config, "-1")
    with engine.connect() as connection:
        assert connection.scalar(sa.text("SELECT * FROM alembic_version")) == (
            "b1c2d3e4f5a6"
        )
        assert (
            connection.scalar(sa.text("SELECT * FROM loop_item_executions")) == payload
        )
    command.upgrade(config, "head")
    with engine.connect() as connection:
        assert connection.scalar(sa.text("SELECT * FROM alembic_version")) == (
            "c7d8e9f0a1b2"
        )
        assert (
            connection.scalar(sa.text("SELECT * FROM loop_item_executions")) == payload
        )
    engine.dispose()
