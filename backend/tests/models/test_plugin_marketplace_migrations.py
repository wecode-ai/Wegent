# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Smoke checks for the squashed plugin marketplace schema migration."""

import importlib.util
from datetime import datetime
from pathlib import Path
from types import ModuleType

import pytest
import sqlalchemy as sa

from app.models.plugin_publication import (
    PluginPublicationCheck,
    PluginPublicationEvent,
    PluginPublicationRequest,
    PluginPublicationRevision,
)


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


def test_plugin_publication_migration_extends_current_head_and_is_reversible() -> None:
    migration = _load_migration("20260829_c2f8d4a6b901_plugin_publication_workflow.py")
    assert migration.revision == "c2f8d4a6b901"
    assert migration.down_revision == "8d3d51c83c99"
    source = Path(migration.__file__).read_text(encoding="utf-8")
    for table in (
        "plugin_publication_requests",
        "plugin_publication_revisions",
        "plugin_publication_checks",
        "plugin_publication_events",
        "plugin_publication_idempotency",
        "plugin_release_idempotency",
    ):
        assert table in source
        assert f'op.drop_table("{table}")' in source
    assert "uniq_plugins_catalog_namespace_slug" in source
    assert "source_tree_sha256" in source
    assert "package_entries_json" in source
    assert "capabilities_json" in source
    assert "publication_revision_id" in source
    assert "source_commit_sha" in source
    assert "scopes_json" not in source
    assert "restrictions_json" not in source
    assert "ForeignKeyConstraint" not in source
    assert "_assert_downgrade_slug_uniqueness(bind)" in source


def test_plugin_publication_models_do_not_declare_foreign_keys() -> None:
    for model in (
        PluginPublicationRequest,
        PluginPublicationRevision,
        PluginPublicationCheck,
        PluginPublicationEvent,
    ):
        assert not model.__table__.foreign_keys


def test_plugin_publication_migration_maps_safe_legacy_pending_and_restores() -> None:
    migration = _load_migration("20260829_c2f8d4a6b901_plugin_publication_workflow.py")
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    plugins = sa.Table(
        "plugins",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("catalog_namespace", sa.String, nullable=False),
        sa.Column("slug", sa.String, nullable=False),
        sa.Column("visibility", sa.String, nullable=False),
        sa.Column("owner_user_id", sa.Integer, nullable=False),
        sa.Column("status", sa.String, nullable=False),
        sa.Column("latest_release_id", sa.Integer, nullable=False),
    )
    releases = sa.Table(
        "plugin_releases",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("plugin_id", sa.Integer, nullable=False),
        sa.Column("version", sa.String, nullable=False),
        sa.Column("manifest_json", sa.JSON, nullable=False),
        sa.Column("storage_key", sa.String, nullable=False),
        sa.Column("sha256", sa.String, nullable=False),
        sa.Column("size_bytes", sa.Integer, nullable=False),
        sa.Column("status", sa.String, nullable=False),
        sa.Column("scan_report_json", sa.JSON, nullable=False),
    )
    submissions = sa.Table(
        "plugin_submissions",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("plugin_id", sa.Integer, nullable=False),
        sa.Column("release_id", sa.Integer, nullable=False),
        sa.Column("submitter_user_id", sa.Integer, nullable=False),
        sa.Column("purpose", sa.String, nullable=False),
        sa.Column("status", sa.String, nullable=False),
        sa.Column("review_note", sa.String, nullable=False),
        sa.Column("submitted_at", sa.DateTime, nullable=False),
    )
    requests = sa.Table(
        "plugin_publication_requests",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("source_plugin_id", sa.Integer, nullable=False),
        sa.Column("submitter_user_id", sa.Integer, nullable=False),
        sa.Column("current_revision_id", sa.Integer, default=0),
        sa.Column("current_revision", sa.Integer, nullable=False),
        sa.Column("aggregate_status", sa.String, nullable=False),
        sa.Column("risk_level", sa.String, nullable=False),
        sa.Column("submitted_at", sa.DateTime, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
    revisions = sa.Table(
        "plugin_publication_revisions",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("request_id", sa.Integer, nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("source_release_id", sa.Integer, nullable=False),
        sa.Column("requested_version", sa.String, nullable=False),
        sa.Column("snapshot_sha256", sa.String, nullable=False),
        sa.Column("source_tree_sha256", sa.String, nullable=False),
        sa.Column("storage_key", sa.String, nullable=False),
        sa.Column("staging_storage_key", sa.String, nullable=False),
        sa.Column("filename", sa.String, nullable=False),
        sa.Column("size_bytes", sa.Integer, nullable=False),
        sa.Column("manifest_snapshot", sa.JSON, nullable=False),
        sa.Column("package_entries_json", sa.JSON, nullable=False),
        sa.Column("package_entry_count", sa.Integer, nullable=False),
        sa.Column("capabilities_json", sa.JSON, nullable=False),
        sa.Column("risk_declaration", sa.JSON, nullable=False),
        sa.Column("release_notes", sa.String, nullable=False),
        sa.Column("test_notes", sa.String, nullable=False),
        sa.Column("source_updated_at", sa.DateTime, nullable=False),
        sa.Column("status", sa.String, nullable=False),
        sa.Column("created_by_user_id", sa.Integer, nullable=False),
        sa.Column("completed_at", sa.DateTime, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
    sa.Table(
        "plugin_publication_events",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("revision_id", sa.Integer, nullable=False),
        sa.Column("event_type", sa.String, nullable=False),
        sa.Column("actor_type", sa.String, nullable=False),
        sa.Column("message", sa.String, nullable=False),
        sa.Column("payload_json", sa.JSON, nullable=False),
        sa.Column("external_event_id", sa.String, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    metadata.create_all(engine)

    submitted_at = datetime(2026, 8, 29, 10, 0, 0)
    with engine.begin() as connection:
        connection.execute(
            plugins.insert(),
            [
                {
                    "id": 1,
                    "catalog_namespace": "enterprise",
                    "slug": "pending-plugin",
                    "visibility": "workspace",
                    "owner_user_id": 7,
                    "status": "pending_review",
                    "latest_release_id": 0,
                },
                {
                    "id": 2,
                    "catalog_namespace": "enterprise",
                    "slug": "published-plugin",
                    "visibility": "workspace",
                    "owner_user_id": 0,
                    "status": "published",
                    "latest_release_id": 2,
                },
            ],
        )
        connection.execute(
            releases.insert(),
            [
                {
                    "id": 1,
                    "plugin_id": 1,
                    "version": "1.0.0",
                    "manifest_json": {"name": "pending-plugin"},
                    "storage_key": "plugins/pending.zip",
                    "sha256": "a" * 64,
                    "size_bytes": 100,
                    "status": "processing",
                    "scan_report_json": {},
                },
                {
                    "id": 2,
                    "plugin_id": 2,
                    "version": "1.0.0",
                    "manifest_json": {"name": "published-plugin"},
                    "storage_key": "plugins/published.zip",
                    "sha256": "b" * 64,
                    "size_bytes": 200,
                    "status": "ready",
                    "scan_report_json": {"checks": ["manifest"]},
                },
            ],
        )
        connection.execute(
            submissions.insert().values(
                id=1,
                plugin_id=1,
                release_id=1,
                submitter_user_id=7,
                purpose="marketplace_publish",
                status="pending",
                review_note="",
                submitted_at=submitted_at,
            )
        )

        candidates = migration._legacy_pending_candidates(connection)
        migration._prepare_legacy_pending_sources(connection, candidates)
        connection.execute(
            plugins.update()
            .where(plugins.c.id == 1)
            .values(catalog_namespace="personal/7")
        )
        migration._assert_catalog_namespace_uniqueness(connection)
        migration._mark_legacy_enterprise_releases(connection)
        migration._migrate_legacy_pending_requests(connection, candidates)

        request_row = connection.execute(sa.select(requests)).mappings().one()
        revision_row = connection.execute(sa.select(revisions)).mappings().one()
        assert request_row["aggregate_status"] == "changes_requested"
        assert revision_row["snapshot_sha256"] == "a" * 64
        assert (
            connection.execute(sa.select(submissions.c.status)).scalar_one()
            == "cancelled"
        )
        published_report = connection.execute(
            sa.select(releases.c.scan_report_json).where(releases.c.id == 2)
        ).scalar_one()
        assert published_report["provenance"] == {"kind": "legacy_direct_publish"}

        migration._restore_migrated_legacy_submissions(connection)
        migration._remove_legacy_release_markers(connection)

        assert (
            connection.execute(sa.select(submissions.c.status)).scalar_one()
            == "pending"
        )
        restored_plugin = connection.execute(
            sa.select(plugins.c.visibility, plugins.c.owner_user_id).where(
                plugins.c.id == 1
            )
        ).one()
        assert restored_plugin == ("workspace", 7)
        restored_report = connection.execute(
            sa.select(releases.c.scan_report_json).where(releases.c.id == 2)
        ).scalar_one()
        assert "provenance" not in restored_report


def test_plugin_publication_downgrade_preflight_blocks_namespace_slug_split() -> None:
    migration = _load_migration("20260829_c2f8d4a6b901_plugin_publication_workflow.py")
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    plugins = sa.Table(
        "plugins",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("catalog_namespace", sa.String, nullable=False),
        sa.Column("slug", sa.String, nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(
            plugins.insert(),
            [
                {
                    "id": 1,
                    "catalog_namespace": "personal/7",
                    "slug": "same-plugin",
                },
                {
                    "id": 2,
                    "catalog_namespace": "enterprise",
                    "slug": "same-plugin",
                },
            ],
        )

        with pytest.raises(RuntimeError) as exc_info:
            migration._assert_downgrade_slug_uniqueness(connection)

        assert "blocked before mutation" in str(exc_info.value)
        assert "same-plugin" in str(exc_info.value)
        remaining = connection.execute(
            sa.select(sa.func.count()).select_from(plugins)
        ).scalar_one()
        assert remaining == 2


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
    cloud_manual = {
        "spec": {
            "source": {"type": "marketplace"},
            "pluginId": 12,
            "updatePolicy": "manual",
        }
    }
    cloud_auto = {
        "spec": {
            "source": {"type": "marketplace"},
            "pluginId": 13,
            "updatePolicy": "auto",
        }
    }
    cloud_without_policy = {
        "spec": {
            "source": {"type": "marketplace"},
            "pluginId": 14,
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
                    "json": cloud_manual,
                },
                {
                    "id": 2,
                    "kind": "InstalledPlugin",
                    "namespace": "default",
                    "is_active": True,
                    "json": cloud_auto,
                },
                {
                    "id": 3,
                    "kind": "InstalledPlugin",
                    "namespace": "default",
                    "is_active": True,
                    "json": cloud_without_policy,
                },
                {
                    "id": 4,
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
        assert upgraded[2]["spec"]["updatePolicy"] == "auto"
        assert upgraded[3]["spec"]["updatePolicy"] == "auto"
        assert upgraded[4]["spec"]["updatePolicy"] == "manual"

        migration.downgrade()
        downgraded = dict(connection.execute(sa.select(kinds.c.id, kinds.c.json)).all())
        assert downgraded[1]["spec"]["updatePolicy"] == "manual"
        assert downgraded[2]["spec"]["updatePolicy"] == "manual"
        assert downgraded[3]["spec"]["updatePolicy"] == "manual"


def test_plugin_failure_count_migration_resets_historical_sync_totals(
    monkeypatch,
) -> None:
    migration = _load_migration(
        "20260813_b7c6d5e4f3a2_reset_plugin_device_failure_counts.py"
    )
    assert migration.down_revision == "8a4c1f2d9e70"
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    installations = sa.Table(
        "plugin_device_installations",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("attempt_count", sa.Integer, nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            installations.insert(),
            [{"id": 1, "attempt_count": 9}, {"id": 2, "attempt_count": 1}],
        )
        monkeypatch.setattr(migration.op, "get_bind", lambda: connection)

        migration.upgrade()

        counts = connection.execute(
            sa.select(installations.c.attempt_count).order_by(installations.c.id)
        ).scalars()
        assert list(counts) == [0, 0]
