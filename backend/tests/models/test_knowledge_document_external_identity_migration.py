# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for the knowledge document external identity migration."""

import importlib.util
import io
from pathlib import Path
from types import ModuleType

import pytest
import sqlalchemy as sa
from pytest import MonkeyPatch
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.dialects import mysql

from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from app.models.knowledge import KnowledgeDocumentExternalSource


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


@pytest.mark.parametrize("source", ["model", "migration"])
def test_mysql_ddl_obeys_review_rules(source: str) -> None:
    output = io.StringIO()
    if source == "model":
        output.write(
            str(
                sa.schema.CreateTable(
                    KnowledgeDocumentExternalSource.__table__
                ).compile(dialect=mysql.dialect())
            )
        )
    else:
        migration = _load_migration()
        migration.op = Operations(
            MigrationContext.configure(
                dialect_name="mysql",
                opts={"as_sql": True, "output_buffer": output},
            )
        )
        migration.upgrade()

    ddl = output.getvalue()
    assert (
        "CONSTRAINT uniq_knowledge_documents_external UNIQUE "
        "(kind_id, external_provider, external_resource_id)" in ddl
    )
    assert "COLLATE" not in ddl.upper()


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
        assert (
            "knowledge_document_external_sources"
            in sa_inspect(connection).get_table_names()
        )
        assert not {"external_provider", "external_resource_id"} & _columns(connection)
        assert not sa_inspect(connection).get_check_constraints("knowledge_documents")
        # Ordinary documents do not acquire an external identity.
        row = connection.execute(
            sa.text("SELECT COUNT(*) FROM knowledge_document_external_sources")
        ).one()
        assert row == (0,)

        migration.downgrade()
        assert (
            "knowledge_document_external_sources"
            not in sa_inspect(connection).get_table_names()
        )
        assert "external_provider" not in _columns(connection)
        assert "external_resource_id" not in _columns(connection)
        assert "uniq_knowledge_documents_external" not in _index_names(connection)


def test_unique_index_rejects_duplicate_external_identity(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        _bind_migration_to_connection(migration, monkeypatch, connection)
        migration.upgrade()

        insert = sa.text(
            "INSERT INTO knowledge_document_external_sources "
            "(document_id, kind_id, external_provider, external_resource_id) "
            "VALUES (:document_id, :kind_id, :provider, :resource_id)"
        )
        connection.execute(
            insert,
            {
                "kind_id": 1,
                "document_id": 1,
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
                    "document_id": 2,
                    "provider": "dingtalk",
                    "resource_id": "doc-1",
                },
            )
        # A different knowledge base may hold the same resource.
        connection.execute(
            insert,
            {
                "kind_id": 2,
                "document_id": 3,
                "provider": "dingtalk",
                "resource_id": "doc-1",
            },
        )
        # A document cannot own a second identity, even for a different resource.
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                insert,
                {
                    "document_id": 1,
                    "kind_id": 1,
                    "provider": "dingtalk",
                    "resource_id": "doc-2",
                },
            )
        # Ordinary documents do not participate in the external identity index.
        connection.execute(
            sa.text(
                "INSERT INTO knowledge_documents (kind_id, name) VALUES "
                "(1, 'regular-1'), (1, 'regular-2')"
            )
        )


def test_no_external_snapshot_mapping_table_or_dual_write_path() -> None:
    """The final implementation must not reintroduce the snapshot mapping design."""
    backend_root = Path(__file__).parents[2]
    for path in (backend_root / "alembic" / "versions").glob("*.py"):
        assert "external_knowledge_snapshots" not in path.read_text(), path.name
    for path in (backend_root / "app" / "models").glob("*.py"):
        assert "ExternalKnowledgeSnapshot" not in path.read_text(), path.name


@pytest.mark.parametrize(
    "column", ["kind_id", "external_provider", "external_resource_id"]
)
def test_identity_fields_reject_null(monkeypatch: MonkeyPatch, column: str) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        _bind_migration_to_connection(migration, monkeypatch, connection)
        migration.upgrade()
        values = {
            "document_id": 1,
            "kind_id": 1,
            "external_provider": "dingtalk",
            "external_resource_id": "doc-1",
        }
        values[column] = None
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(
                sa.text(
                    "INSERT INTO knowledge_document_external_sources "
                    "(document_id, kind_id, external_provider, external_resource_id) "
                    "VALUES (:document_id, :kind_id, :external_provider, :external_resource_id)"
                ),
                values,
            )
