# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for attachment source-context identity migration."""

import importlib.util
from datetime import datetime, timedelta
from pathlib import Path
from types import ModuleType

import pytest
import sqlalchemy as sa

from alembic.migration import MigrationContext
from alembic.operations import Operations


def _load_migration(operations: Operations) -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20260911_a6c4e2f8b901_add_attachment_source_context_identity.py"
    )
    spec = importlib.util.spec_from_file_location(
        "attachment_source_context_identity_migration",
        path,
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = operations
    return module


def _legacy_loop_items(connection: sa.Connection) -> sa.Table:
    metadata = sa.MetaData()
    table = sa.Table(
        "loop_items",
        metadata,
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("resource_type", sa.String(24), nullable=False),
        sa.Column("loop_item_id", sa.String(64)),
        sa.Column("object_key", sa.String(1400)),
        sa.Column("metadata", sa.JSON()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    metadata.create_all(connection)
    return table


def _rows_by_id(connection: sa.Connection) -> dict[str, dict[str, object]]:
    table = sa.Table("loop_items", sa.MetaData(), autoload_with=connection)
    return {
        str(row["id"]): dict(row)
        for row in connection.execute(table.select()).mappings()
    }


def test_upgrade_deduplicates_identity_without_deleting_attachments() -> None:
    engine = sa.create_engine("sqlite://")
    created_at = datetime(2026, 9, 10, 12)
    with engine.begin() as connection:
        table = _legacy_loop_items(connection)
        connection.execute(
            table.insert(),
            [
                {
                    "id": "canonical",
                    "resource_type": "attachment",
                    "loop_item_id": "issue-1",
                    "object_key": "objects/canonical",
                    "metadata": {"source_context_id": 42, "label": "first"},
                    "created_at": created_at,
                },
                {
                    "id": "duplicate",
                    "resource_type": "attachment",
                    "loop_item_id": "issue-1",
                    "object_key": "objects/duplicate",
                    "metadata": {"source_context_id": 42, "label": "second"},
                    "created_at": created_at + timedelta(seconds=1),
                },
                {
                    "id": "other-issue",
                    "resource_type": "attachment",
                    "loop_item_id": "issue-2",
                    "object_key": "objects/other-issue",
                    "metadata": {"source_context_id": 42},
                    "created_at": created_at,
                },
                {
                    "id": "not-attachment",
                    "resource_type": "delivery",
                    "loop_item_id": "issue-1",
                    "object_key": "objects/delivery",
                    "metadata": {"source_context_id": 42},
                    "created_at": created_at,
                },
                {
                    "id": "unbound-attachment-a",
                    "resource_type": "attachment",
                    "loop_item_id": None,
                    "object_key": "objects/unbound-a",
                    "metadata": {"source_context_id": 42},
                    "created_at": created_at,
                },
                {
                    "id": "unbound-attachment-b",
                    "resource_type": "attachment",
                    "loop_item_id": None,
                    "object_key": "objects/unbound-b",
                    "metadata": {"source_context_id": 42},
                    "created_at": created_at,
                },
            ],
        )
        operations = Operations(MigrationContext.configure(connection))
        migration = _load_migration(operations)

        migration.upgrade()

        rows = _rows_by_id(connection)
        assert set(rows) == {
            "canonical",
            "duplicate",
            "other-issue",
            "not-attachment",
            "unbound-attachment-a",
            "unbound-attachment-b",
        }
        assert rows["canonical"]["source_context_id"] == 42
        assert rows["duplicate"]["source_context_id"] is None
        assert rows["other-issue"]["source_context_id"] == 42
        assert rows["not-attachment"]["source_context_id"] is None
        assert rows["unbound-attachment-a"]["source_context_id"] == 42
        assert rows["unbound-attachment-b"]["source_context_id"] == 42
        assert rows["duplicate"]["object_key"] == "objects/duplicate"
        assert rows["duplicate"]["metadata"] == {
            "source_context_id": 42,
            "label": "second",
        }

        upgraded = sa.Table("loop_items", sa.MetaData(), autoload_with=connection)
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                upgraded.insert().values(
                    id="new-duplicate",
                    resource_type="attachment",
                    loop_item_id="issue-1",
                    object_key="objects/new-duplicate",
                    metadata={"source_context_id": 42},
                    source_context_id=42,
                    created_at=created_at + timedelta(seconds=2),
                )
            )

    engine.dispose()


def test_downgrade_upgrade_cycle_preserves_rows_and_canonical_identity() -> None:
    engine = sa.create_engine("sqlite://")
    created_at = datetime(2026, 9, 10, 12)
    with engine.begin() as connection:
        table = _legacy_loop_items(connection)
        connection.execute(
            table.insert(),
            [
                {
                    "id": "same-time-a",
                    "resource_type": "attachment",
                    "loop_item_id": "issue-1",
                    "object_key": "objects/a",
                    "metadata": {"source_context_id": 7},
                    "created_at": created_at,
                },
                {
                    "id": "same-time-b",
                    "resource_type": "attachment",
                    "loop_item_id": "issue-1",
                    "object_key": "objects/b",
                    "metadata": {"source_context_id": 7},
                    "created_at": created_at,
                },
            ],
        )
        operations = Operations(MigrationContext.configure(connection))
        migration = _load_migration(operations)

        migration.upgrade()
        first_upgrade = _rows_by_id(connection)
        assert first_upgrade["same-time-a"]["source_context_id"] == 7
        assert first_upgrade["same-time-b"]["source_context_id"] is None

        migration.downgrade()
        downgraded = _rows_by_id(connection)
        assert set(downgraded) == {"same-time-a", "same-time-b"}
        assert "source_context_id" not in next(iter(downgraded.values()))
        assert downgraded["same-time-a"]["object_key"] == "objects/a"
        assert downgraded["same-time-b"]["object_key"] == "objects/b"

        migration.upgrade()
        second_upgrade = _rows_by_id(connection)
        assert second_upgrade["same-time-a"]["source_context_id"] == 7
        assert second_upgrade["same-time-b"]["source_context_id"] is None

    engine.dispose()
