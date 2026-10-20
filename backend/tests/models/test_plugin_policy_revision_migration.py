"""The policy identity migration adds only a reversible, scoped unique index."""

import importlib.util
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from alembic.migration import MigrationContext
from alembic.operations import Operations


def migration_module():
    path = (
        Path(__file__).parents[2]
        / "alembic/versions/20261020_b9d8e7a6c501_unique_account_auth_policy.py"
    )
    spec = importlib.util.spec_from_file_location("policy_identity_migration", path)
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


def create_kinds(connection):
    connection.execute(
        text(
            "CREATE TABLE kinds(id INTEGER PRIMARY KEY, user_id INTEGER, "
            "kind TEXT, namespace TEXT, name TEXT, json TEXT)"
        )
    )


def test_policy_migration_upgrade_and_downgrade_preserve_existing_data():
    migration = migration_module()
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        create_kinds(connection)
        insert_policy(connection)
        original_columns = [
            (
                column["name"],
                str(column["type"]),
                column["nullable"],
                column["default"],
                column["primary_key"],
            )
            for column in inspect(connection).get_columns("kinds")
        ]
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            assert inspect(connection).get_table_names() == ["kinds"]
            assert [
                (
                    column["name"],
                    str(column["type"]),
                    column["nullable"],
                    column["default"],
                    column["primary_key"],
                )
                for column in inspect(connection).get_columns("kinds")
            ] == original_columns
            with pytest.raises(IntegrityError):
                insert_policy(connection)
            insert_policy(connection, user_id=18)
            insert_policy(connection, kind="UnrelatedKind")
            insert_policy(connection, kind="UnrelatedKind")
            assert connection.scalar(text("SELECT json FROM kinds WHERE id=1")) == (
                '{"spec":{"enabled":false}}'
            )
            migration.downgrade()
            insert_policy(connection)
    engine.dispose()


def test_policy_migration_refuses_to_discard_duplicate_preferences():
    migration = migration_module()
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        create_kinds(connection)
        insert_policy(connection)
        insert_policy(connection)
        with Operations.context(MigrationContext.configure(connection)):
            with pytest.raises(RuntimeError, match="require reconciliation"):
                migration.upgrade()
        assert connection.scalar(text("SELECT COUNT(*) FROM kinds")) == 2
    engine.dispose()
