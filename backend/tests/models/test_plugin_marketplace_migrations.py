# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for reversible plugin marketplace data migrations."""

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa


class MigrationOperations:
    def __init__(self, connection: sa.Connection) -> None:
        self.connection = connection

    def get_bind(self) -> sa.Connection:
        return self.connection

    def create_table(self, name: str, *columns: sa.Column) -> None:
        sa.Table(name, sa.MetaData(), *columns).create(self.connection)

    def drop_table(self, name: str) -> None:
        sa.Table(name, sa.MetaData(), autoload_with=self.connection).drop(
            self.connection
        )

    def execute(self, statement: str) -> None:
        self.connection.execute(sa.text(statement))


def _load_migration(filename: str) -> ModuleType:
    path = Path(__file__).parents[2] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(filename, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_source_provider_rename_downgrade_only_restores_changed_plugins() -> None:
    migration = _load_migration(
        "20260727_f7a8b9c0d1e3_rename_source_provider_wegent_to_wework.py"
    )
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "CREATE TABLE plugins (id BIGINT PRIMARY KEY, source_provider VARCHAR(50))"
            )
        )
        connection.execute(
            sa.text("INSERT INTO plugins VALUES (1, 'wegent'), (2, 'wework')")
        )
        migration.op = MigrationOperations(connection)

        migration.upgrade()
        upgraded_providers = dict(
            connection.execute(
                sa.text("SELECT id, source_provider FROM plugins ORDER BY id")
            ).all()
        )
        assert upgraded_providers == {1: "wework", 2: "wework"}
        connection.execute(sa.text("INSERT INTO plugins VALUES (3, 'wework')"))
        migration.downgrade()

        providers = dict(
            connection.execute(
                sa.text("SELECT id, source_provider FROM plugins ORDER BY id")
            ).all()
        )
        assert providers == {1: "wegent", 2: "wework", 3: "wework"}


def test_github_reclassification_downgrade_restores_full_snapshots() -> None:
    migration = _load_migration(
        "20260730_f1a2b3c4d5e6_reclassify_github_mirror_as_wework.py"
    )
    engine = sa.create_engine("sqlite://")
    original_payload = json.dumps(
        {
            "spec": {
                "pluginId": 1,
                "sourceProvider": "codex",
                "sourceLabel": "Codex",
                "visibility": "workspace",
            }
        }
    )
    untouched_payload = json.dumps({"spec": {"pluginId": 2}})
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
                CREATE TABLE plugins (
                    id BIGINT PRIMARY KEY,
                    slug VARCHAR(100),
                    source_type VARCHAR(20),
                    source_provider VARCHAR(50),
                    visibility VARCHAR(20)
                )
                """
            )
        )
        connection.execute(
            sa.text(
                """
                CREATE TABLE kinds (
                    id BIGINT PRIMARY KEY,
                    kind VARCHAR(50),
                    is_active INTEGER,
                    json TEXT
                )
                """
            )
        )
        connection.execute(
            sa.text(
                """
                INSERT INTO plugins VALUES
                    (1, 'github', 'mirror', 'codex', 'workspace'),
                    (2, 'github', 'mirror', 'wework', 'personal')
                """
            )
        )
        connection.execute(
            sa.text(
                "INSERT INTO kinds VALUES "
                "(10, 'InstalledPlugin', 1, :original), "
                "(11, 'InstalledPlugin', 1, :untouched)"
            ),
            {"original": original_payload, "untouched": untouched_payload},
        )
        migration.op = MigrationOperations(connection)

        migration.upgrade()
        upgraded_plugin = connection.execute(
            sa.text("SELECT source_provider, visibility FROM plugins WHERE id = 1")
        ).one()
        upgraded_payload = json.loads(
            connection.execute(
                sa.text("SELECT json FROM kinds WHERE id = 10")
            ).scalar_one()
        )
        assert upgraded_plugin == ("wework", "public")
        assert upgraded_payload["spec"] == {
            "pluginId": 1,
            "sourceProvider": "wegent",
            "sourceLabel": migration.GITHUB_SOURCE_LABEL,
            "visibility": "public",
        }
        connection.execute(
            sa.text(
                "INSERT INTO plugins VALUES "
                "(3, 'github', 'mirror', 'wework', 'public')"
            )
        )
        migration.downgrade()

        plugins = connection.execute(
            sa.text("SELECT id, source_provider, visibility FROM plugins ORDER BY id")
        ).all()
        payloads = dict(
            connection.execute(sa.text("SELECT id, json FROM kinds ORDER BY id")).all()
        )
        assert plugins == [
            (1, "codex", "workspace"),
            (2, "wework", "personal"),
            (3, "wework", "public"),
        ]
        assert payloads == {10: original_payload, 11: untouched_payload}
