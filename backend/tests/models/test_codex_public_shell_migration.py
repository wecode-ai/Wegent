# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Data migration coverage for the built-in Codex public Shell."""

import importlib.util
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from pytest import MonkeyPatch
from sqlalchemy.engine import Connection, Engine


def _load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20260916_c9d4e7f1a2b3_add_codex_public_shell.py"
    )
    spec = importlib.util.spec_from_file_location("codex_public_shell_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _legacy_engine() -> Engine:
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    sa.Table(
        "kinds",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer, nullable=False),
        sa.Column("kind", sa.String(50), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("namespace", sa.String(100), nullable=False),
        sa.Column("json", sa.JSON, nullable=False),
        sa.Column("is_active", sa.Boolean),
    )
    metadata.create_all(engine)
    return engine


def _bind(
    migration: ModuleType, monkeypatch: MonkeyPatch, connection: Connection
) -> None:
    monkeypatch.setattr(
        migration,
        "op",
        Operations(MigrationContext.configure(connection)),
    )


def _codex_rows(connection: Connection) -> list[sa.RowMapping]:
    kinds = sa.Table("kinds", sa.MetaData(), autoload_with=connection)
    return list(
        connection.execute(
            sa.select(kinds).where(
                kinds.c.user_id == 0,
                kinds.c.kind == "Shell",
                kinds.c.name == "Codex",
                kinds.c.namespace == "default",
            )
        ).mappings()
    )


def test_upgrade_adds_missing_codex_shell_idempotently_and_downgrade_removes_it(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        _bind(migration, monkeypatch, connection)

        migration.upgrade()
        migration.upgrade()

        rows = _codex_rows(connection)
        assert len(rows) == 1
        assert rows[0]["is_active"] is True
        assert rows[0]["json"]["spec"]["shellType"] == "Codex"
        assert rows[0]["json"]["metadata"]["labels"]["type"] == "local_engine"

        migration.downgrade()

        assert _codex_rows(connection) == []
    engine.dispose()


def test_upgrade_preserves_existing_public_codex_shell(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        kinds = sa.Table("kinds", sa.MetaData(), autoload_with=connection)
        existing_payload = {
            "kind": "Shell",
            "metadata": {"name": "Codex", "namespace": "default"},
            "spec": {"shellType": "Codex", "baseImage": "custom-image"},
        }
        connection.execute(
            kinds.insert().values(
                user_id=0,
                kind="Shell",
                name="Codex",
                namespace="default",
                json=existing_payload,
                is_active=True,
            )
        )
        _bind(migration, monkeypatch, connection)

        migration.upgrade()
        migration.downgrade()

        rows = _codex_rows(connection)
        assert len(rows) == 1
        assert rows[0]["json"] == existing_payload
    engine.dispose()
