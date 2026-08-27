# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for the knowledge document external identity migration."""

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

import pytest
import sqlalchemy as sa
from pytest import MonkeyPatch
from sqlalchemy import inspect as sa_inspect

from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext


def _load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20260826_c5d6e7f8a9b0_add_knowledge_document_external_identity.py"
    )
    spec = importlib.util.spec_from_file_location("external_identity_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_revision_extends_main_head() -> None:
    migration = _load_migration()

    assert migration.revision == "c5d6e7f8a9b0"
    assert migration.down_revision == "7a4c2e9f1b30"


def _migration_with_mock_op(
    monkeypatch: MonkeyPatch,
) -> tuple[ModuleType, MagicMock]:
    migration = _load_migration()
    op = MagicMock()
    monkeypatch.setattr(migration, "op", op)
    return migration, op


def _legacy_engine() -> sa.engine.Engine:
    """A pre-migration knowledge_documents table on an in-memory engine."""
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    sa.Table(
        "knowledge_documents",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("kind_id", sa.Integer, nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
    )
    metadata.create_all(engine)
    return engine


def _columns(connection) -> set[str]:
    return {
        column["name"]
        for column in sa_inspect(connection).get_columns("knowledge_documents")
    }


def _index_names(connection) -> set[str]:
    return {
        index["name"]
        for index in sa_inspect(connection).get_indexes("knowledge_documents")
    }


def _bind_migration_to_connection(
    migration: ModuleType, monkeypatch: MonkeyPatch, connection
) -> None:
    """Point the migration's op proxy at a live engine connection."""
    operations = Operations(MigrationContext.configure(connection))
    monkeypatch.setattr(migration, "op", operations)


def test_upgrade_downgrade_cycle_runs_against_real_engine(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "INSERT INTO knowledge_documents (kind_id, name) VALUES (1, 'legacy')"
            )
        )
        _bind_migration_to_connection(migration, monkeypatch, connection)

        migration.upgrade()
        assert {"external_provider", "external_resource_id"} <= _columns(connection)
        assert "uq_knowledge_documents_external" in _index_names(connection)
        # Legacy rows keep the regular-document identity: both columns NULL.
        row = connection.execute(
            sa.text(
                "SELECT external_provider, external_resource_id FROM knowledge_documents"
            )
        ).one()
        assert row == (None, None)

        migration.downgrade()
        assert "external_provider" not in _columns(connection)
        assert "external_resource_id" not in _columns(connection)
        assert "uq_knowledge_documents_external" not in _index_names(connection)


def test_unique_index_rejects_duplicate_external_identity(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        _bind_migration_to_connection(migration, monkeypatch, connection)
        migration.upgrade()

        insert = sa.text(
            "INSERT INTO knowledge_documents (kind_id, name, external_provider, "
            "external_resource_id) VALUES (:kind_id, :name, :provider, :resource_id)"
        )
        connection.execute(
            insert,
            {
                "kind_id": 1,
                "name": "doc-a",
                "provider": "dingtalk",
                "resource_id": "doc-1",
            },
        )
        # The same external resource may appear once per knowledge base only.
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                insert,
                {
                    "kind_id": 1,
                    "name": "doc-a-duplicate",
                    "provider": "dingtalk",
                    "resource_id": "doc-1",
                },
            )
        # A different knowledge base may hold the same resource.
        connection.execute(
            insert,
            {
                "kind_id": 2,
                "name": "doc-b",
                "provider": "dingtalk",
                "resource_id": "doc-1",
            },
        )
        # Regular documents (both columns NULL) never conflict.
        connection.execute(
            insert,
            {"kind_id": 1, "name": "regular-1", "provider": None, "resource_id": None},
        )
        connection.execute(
            insert,
            {"kind_id": 1, "name": "regular-2", "provider": None, "resource_id": None},
        )


def test_identity_constraint_rejects_partial_external_identity(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        _bind_migration_to_connection(migration, monkeypatch, connection)
        migration.upgrade()

        insert = sa.text(
            "INSERT INTO knowledge_documents (kind_id, name, external_provider, "
            "external_resource_id) VALUES (1, :name, :provider, :resource_id)"
        )
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                insert,
                {"name": "provider-only", "provider": "dingtalk", "resource_id": None},
            )
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                insert,
                {"name": "resource-only", "provider": None, "resource_id": "doc-1"},
            )


def test_no_external_snapshot_mapping_table_or_dual_write_path() -> None:
    """The final implementation must not reintroduce the snapshot mapping design."""
    backend_root = Path(__file__).parents[2]
    for path in (backend_root / "alembic" / "versions").glob("*.py"):
        assert "external_knowledge_snapshots" not in path.read_text(), path.name
    for path in (backend_root / "app" / "models").glob("*.py"):
        assert "ExternalKnowledgeSnapshot" not in path.read_text(), path.name


def test_upgrade_adds_identity_columns_and_unique_index(
    monkeypatch: MonkeyPatch,
) -> None:
    migration, op = _migration_with_mock_op(monkeypatch)

    migration.upgrade()

    added_columns = [call.args[1].name for call in op.add_column.call_args_list]
    assert added_columns == ["external_provider", "external_resource_id"]
    batch_op = op.batch_alter_table.return_value.__enter__.return_value
    batch_op.create_check_constraint.assert_called_once_with(
        "ck_knowledge_documents_external_identity_pair",
        "(external_provider IS NULL AND external_resource_id IS NULL) OR "
        "(external_provider IS NOT NULL AND external_resource_id IS NOT NULL)",
    )
    op.create_index.assert_called_once_with(
        "uq_knowledge_documents_external",
        "knowledge_documents",
        ["kind_id", "external_provider", "external_resource_id"],
        unique=True,
    )


def test_downgrade_reverses_upgrade(monkeypatch: MonkeyPatch) -> None:
    migration, op = _migration_with_mock_op(monkeypatch)

    migration.downgrade()

    op.drop_index.assert_called_once_with(
        "uq_knowledge_documents_external", table_name="knowledge_documents"
    )
    batch_op = op.batch_alter_table.return_value.__enter__.return_value
    batch_op.drop_constraint.assert_called_once_with(
        "ck_knowledge_documents_external_identity_pair", type_="check"
    )
    dropped_columns = [call.args[1] for call in op.drop_column.call_args_list]
    assert dropped_columns == ["external_resource_id", "external_provider"]
