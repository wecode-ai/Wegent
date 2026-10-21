"""Retired policy migrations preserve data and never add a kinds index."""

import importlib.util
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, inspect, text

from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.models.kind import Kind

LEGACY_INDEX = "uq_kinds_account_auth_policy"


def migration_module(filename):
    path = Path(__file__).parents[2] / "alembic/versions" / filename
    spec = importlib.util.spec_from_file_location(filename.removesuffix(".py"), path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def insert_policy(connection, user_id=17, kind="ConnectorAuthPolicy"):
    connection.execute(
        text(
            "INSERT INTO kinds(user_id, kind, namespace, name, json) "
            "VALUES(:user_id, :kind, 'plugin-auth', 'account', :payload)"
        ),
        {"user_id": user_id, "kind": kind, "payload": '{"spec":{"enabled":false}}'},
    )


def column_layout(connection):
    return [
        {**column, "type": str(column["type"])}
        for column in inspect(connection).get_columns("kinds")
    ]


@pytest.mark.parametrize("legacy_index", [False, True])
def test_policy_migrations_preserve_preferences_and_do_no_unneeded_ddl(legacy_index):
    retired = migration_module("20261020_b9d8e7a6c501_unique_account_auth_policy.py")
    cleanup = migration_module(
        "20261021_c0e9f8d7a612_remove_account_auth_policy_index.py"
    )
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE kinds(id INTEGER PRIMARY KEY, user_id INTEGER, "
                "kind TEXT, namespace TEXT, name TEXT, json TEXT)"
            )
        )
        connection.execute(text("CREATE INDEX unrelated_index ON kinds(name)"))
        insert_policy(connection)
        insert_policy(connection, kind="UnrelatedKind")
        insert_policy(connection, kind="UnrelatedKind")
        if legacy_index:
            connection.execute(
                text(
                    f"CREATE UNIQUE INDEX {LEGACY_INDEX} ON kinds "
                    "((CASE WHEN kind = 'ConnectorAuthPolicy' "
                    "AND namespace = 'plugin-auth' AND name = 'account' "
                    "THEN user_id ELSE NULL END))"
                )
            )
        original_columns = column_layout(connection)
        original_rows = connection.execute(text("SELECT * FROM kinds")).all()
        statements = []

        def record_sql(_conn, _cursor, statement, _params, _context, _many):
            statements.append(statement)

        event.listen(connection, "before_cursor_execute", record_sql)
        with Operations.context(MigrationContext.configure(connection)):
            retired.upgrade()
            cleanup.upgrade()
            cleanup.upgrade()
            cleanup.downgrade()
            retired.downgrade()
        event.remove(connection, "before_cursor_execute", record_sql)

        ddl = [
            statement
            for statement in statements
            if statement.split()[0].upper() in {"CREATE", "ALTER", "DROP"}
        ]
        assert len(ddl) == int(legacy_index)
        assert all("DROP INDEX" in statement.upper() for statement in ddl)
        assert column_layout(connection) == original_columns
        assert connection.execute(text("SELECT * FROM kinds")).all() == original_rows
        assert connection.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'index'")
        ).scalars().all() == ["unrelated_index"]
        # The no-index migration does not discard or reject existing duplicates.
        insert_policy(connection)
        assert connection.scalar(text("SELECT COUNT(*) FROM kinds")) == 4
    engine.dispose()


def test_shared_kind_model_has_no_account_policy_unique_index():
    assert LEGACY_INDEX not in {index.name for index in Kind.__table__.indexes}
