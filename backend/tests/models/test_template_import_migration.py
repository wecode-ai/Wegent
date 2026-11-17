# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the new receipt schema upgrade, constraints, and rollback."""

import importlib.util
from datetime import datetime
from pathlib import Path

import pytest
import sqlalchemy as sa

from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_template_import_migration_upgrades_and_downgrades() -> None:
    path = (
        Path(__file__).parents[2]
        / "alembic/versions/20261117_b7e8f9a0c1d2_template_import_receipts.py"
    )
    spec = importlib.util.spec_from_file_location("template_import_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.revision == "b7e8f9a0c1d2"
    assert migration.down_revision == "b1c2d3e4f5a6"
    engine = sa.create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("PRAGMA foreign_keys = ON")
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            inspector = sa.inspect(connection)
            assert inspector.get_table_names() == [
                "template_import_operations",
                "template_import_receipts",
            ]
            constraint = inspector.get_unique_constraints("template_import_operations")
            assert constraint[0]["column_names"] == [
                "actor_user_id",
                "project_id",
                "protocol_version",
                "intent_sha256",
            ]
            assert inspector.get_pk_constraint("template_import_receipts")[
                "constrained_columns"
            ] == ["operation_id", "step_key"]
            foreign_key = inspector.get_foreign_keys("template_import_receipts")[0]
            assert foreign_key["referred_table"] == "template_import_operations"
            assert foreign_key["options"]["ondelete"] == "CASCADE"
            tables = sa.MetaData()
            operations = sa.Table(
                "template_import_operations", tables, autoload_with=connection
            )
            receipts = sa.Table(
                "template_import_receipts", tables, autoload_with=connection
            )
            operation = {
                "id": "operation-1",
                "project_id": "project-1",
                "actor_user_id": 7,
                "protocol_version": 1,
                "intent_sha256": "a" * 64,
                "intent_encrypted": "synthetic-ciphertext",
                "manifest": [],
                "created_at": datetime(2026, 11, 17),
                "updated_at": datetime(2026, 11, 17),
            }
            connection.execute(operations.insert(), operation)
            with pytest.raises(sa.exc.IntegrityError), connection.begin_nested():
                connection.execute(
                    operations.insert(), {**operation, "id": "operation-2"}
                )
            connection.execute(
                receipts.insert(),
                {
                    "operation_id": "operation-1",
                    "step_key": "group:test",
                    "kind": "group",
                    "request_sha256": "b" * 64,
                    "resource_id": "group-1",
                    "completed_at": datetime(2026, 11, 17),
                },
            )
            connection.execute(operations.delete())
            assert (
                connection.scalar(sa.select(sa.func.count()).select_from(receipts)) == 0
            )
            migration.downgrade()
            assert sa.inspect(connection).get_table_names() == []
            migration.upgrade()
            assert len(sa.inspect(connection).get_table_names()) == 2
    finally:
        engine.dispose()
