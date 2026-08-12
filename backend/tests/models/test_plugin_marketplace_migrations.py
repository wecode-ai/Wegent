# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Smoke checks for the squashed plugin marketplace schema migration."""

import importlib.util
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa


def _load_migration(filename: str) -> ModuleType:
    path = Path(__file__).parents[2] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(filename, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_plugin_marketplace_v2_is_single_revision_on_main_head() -> None:
    migration = _load_migration("20260804_d4e5f6a7b8c9_add_plugin_marketplace_v2.py")
    assert migration.revision == "d4e5f6a7b8c9"
    assert migration.down_revision == "a8b9c0d1e2f3"
    source = Path(migration.__file__).read_text(encoding="utf-8")
    assert "allow_copy" in source
    assert "purpose" in source
    assert 'create_table(\n        "plugins"' in source
    assert "ForeignKey" not in source
    assert "uniq_plugins_slug" in source
    assert "comment=" in source
    assert "COLLATE" not in source
    assert "1970-01-01 00:00:00.000000" in source


def test_plugin_auto_update_migration_upgrades_and_downgrades_cloud_installs(
    monkeypatch,
) -> None:
    migration = _load_migration("20260812_8a4c1f2d9e70_enable_plugin_auto_update.py")
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    kinds = sa.Table(
        "kinds",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("kind", sa.String),
        sa.Column("namespace", sa.String),
        sa.Column("is_active", sa.Boolean),
        sa.Column("json", sa.JSON),
    )
    metadata.create_all(engine)
    cloud = {
        "spec": {
            "source": {"type": "marketplace"},
            "pluginId": 12,
            "updatePolicy": "manual",
        }
    }
    upload = {
        "spec": {
            "source": {"type": "upload"},
            "updatePolicy": "manual",
        }
    }
    with engine.begin() as connection:
        connection.execute(
            kinds.insert(),
            [
                {
                    "id": 1,
                    "kind": "InstalledPlugin",
                    "namespace": "default",
                    "is_active": True,
                    "json": cloud,
                },
                {
                    "id": 2,
                    "kind": "InstalledPlugin",
                    "namespace": "default",
                    "is_active": True,
                    "json": upload,
                },
            ],
        )
        monkeypatch.setattr(migration.op, "get_bind", lambda: connection)

        migration.upgrade()
        upgraded = dict(connection.execute(sa.select(kinds.c.id, kinds.c.json)).all())
        assert upgraded[1]["spec"]["updatePolicy"] == "auto"
        assert upgraded[2]["spec"]["updatePolicy"] == "manual"

        migration.downgrade()
        downgraded = dict(connection.execute(sa.select(kinds.c.id, kinds.c.json)).all())
        assert downgraded[1]["spec"]["updatePolicy"] == "manual"
