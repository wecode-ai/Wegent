"""Verify notification storage transitions without losing messages or read times."""

import importlib.util
from datetime import datetime
from io import StringIO
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from sqlalchemy.dialects import mysql
from sqlalchemy.engine import Connection
from sqlalchemy.schema import CreateTable

from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.models.wework_notification import WeworkNotification


def _load(filename: str, operations: Operations) -> ModuleType:
    path = Path(__file__).parents[2] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(filename.removesuffix(".py"), path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = operations
    return module


def test_upgrade_downgrade_preserve_read_state_and_navigation() -> None:
    engine = sa.create_engine("sqlite://")
    created = datetime(2026, 9, 8, 1, 0)
    read = datetime(2026, 9, 8, 2, 0)
    with engine.begin() as connection:
        operations = Operations(MigrationContext.configure(connection))
        _load("20260907_f5b8c0d3e2a1_add_wework_notifications.py", operations).upgrade()
        _load(
            "20260908_a6c9d1e4f3b2_optional_notification_source.py", operations
        ).upgrade()
        legacy = sa.Table(
            "wework_notifications", sa.MetaData(), autoload_with=connection
        )
        connection.execute(
            legacy.insert(),
            [
                dict(
                    id="unread",
                    user_id=1,
                    actor_user_id=1,
                    kind="message",
                    title="Hello",
                    body="你好",
                    url=None,
                    payload={},
                    created_at=created,
                    read_at=None,
                ),
                dict(
                    id="read",
                    user_id=1,
                    actor_user_id=1,
                    kind="message",
                    title="Board",
                    body="Open board",
                    url="wework://boards",
                    payload={},
                    created_at=created,
                    read_at=read,
                ),
            ],
        )
        migration = _load(
            "20260908_b7d0e2f5a4c3_nonnullable_notification_storage.py", operations
        )
        migration.upgrade()
        _assert_upgraded(connection, created, read)
        migration.downgrade()
        restored = sa.Table(
            "wework_notifications", sa.MetaData(), autoload_with=connection
        )
        rows = {
            row["id"]: row for row in connection.execute(restored.select()).mappings()
        }
        assert rows["unread"]["url"] is None
        assert rows["unread"]["read_at"] is None
        assert rows["read"]["url"] == "wework://boards"
        assert rows["read"]["read_at"] == read
        migration.upgrade()
        _assert_upgraded(connection, created, read)
    engine.dispose()


def _assert_upgraded(connection: Connection, created: datetime, read: datetime) -> None:
    inspector = sa.inspect(connection)
    columns = inspector.get_columns("wework_notifications")
    assert all(not column["nullable"] for column in columns)
    assert {column["name"] for column in columns} == set(
        WeworkNotification.__table__.columns.keys()
    )
    assert [
        index["name"] for index in inspector.get_indexes("wework_notifications")
    ] == ["idx_wework_notifications_inbox"]
    table = sa.Table("wework_notifications", sa.MetaData(), autoload_with=connection)
    rows = {row["id"]: row for row in connection.execute(table.select()).mappings()}
    assert len(rows) == 2
    assert rows["unread"]["url"] == ""
    assert rows["unread"]["body"] == "你好"
    assert rows["unread"]["is_read"] is False
    assert rows["unread"]["read_status_changed_at"] == created
    assert rows["read"]["is_read"] is True
    assert rows["read"]["read_status_changed_at"] == read


def test_mysql_ddl_and_migration_follow_nonnullable_schema_contract() -> None:
    table = WeworkNotification.__table__
    assert table.comment
    for column in table.columns:
        assert column.comment
        assert not column.nullable
        if not column.primary_key and not isinstance(column.type, (sa.Text, sa.JSON)):
            assert column.server_default is not None
    ddl = str(CreateTable(table).compile(dialect=mysql.dialect()))
    assert "NOT NULL" in ddl
    output = StringIO()
    operations = Operations(
        MigrationContext.configure(
            dialect_name="mysql", opts={"as_sql": True, "output_buffer": output}
        )
    )
    migration = _load(
        "20260908_b7d0e2f5a4c3_nonnullable_notification_storage.py", operations
    )
    migration.upgrade()
    sql = output.getvalue()
    assert "DROP COLUMN read_at" in sql
    assert "CREATE INDEX idx_wework_notifications_inbox" in sql
    assert "COALESCE(read_at, created_at)" in sql
    assert "COMMENT" in sql
