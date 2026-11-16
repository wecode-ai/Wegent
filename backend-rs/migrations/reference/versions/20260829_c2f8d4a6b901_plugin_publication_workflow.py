"""Add enterprise plugin publication workflow.

Revision ID: c2f8d4a6b901
Revises: 8d3d51c83c99
Create Date: 2026-08-29
"""

from collections import Counter
from datetime import datetime
from typing import Any, Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "c2f8d4a6b901"
down_revision: Union[str, Sequence[str], None] = "8d3d51c83c99"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_EPOCH = "1970-01-01 00:00:00.000000"


def _bigint() -> sa.types.TypeEngine:
    return sa.BigInteger().with_variant(sa.Integer, "sqlite")


def _datetime() -> sa.types.TypeEngine:
    return sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def _legacy_pending_candidates(bind: sa.Connection) -> list[dict[str, Any]]:
    """Select only one-to-one legacy pending submissions safe to remap."""
    metadata = sa.MetaData()
    plugins = sa.Table("plugins", metadata, autoload_with=bind)
    releases = sa.Table("plugin_releases", metadata, autoload_with=bind)
    submissions = sa.Table("plugin_submissions", metadata, autoload_with=bind)
    rows = list(
        bind.execute(
            sa.select(
                submissions.c.id.label("submission_id"),
                submissions.c.plugin_id,
                submissions.c.release_id,
                submissions.c.submitter_user_id,
                submissions.c.review_note,
                submissions.c.submitted_at,
                plugins.c.slug,
                plugins.c.visibility.label("previous_visibility"),
                plugins.c.owner_user_id.label("previous_owner_user_id"),
                plugins.c.status.label("plugin_status"),
                plugins.c.latest_release_id,
                releases.c.version,
                releases.c.manifest_json,
                releases.c.storage_key,
                releases.c.sha256,
                releases.c.size_bytes,
            )
            .select_from(
                submissions.join(plugins, plugins.c.id == submissions.c.plugin_id).join(
                    releases, releases.c.id == submissions.c.release_id
                )
            )
            .where(
                submissions.c.purpose == "marketplace_publish",
                submissions.c.status == "pending",
                plugins.c.visibility == "workspace",
                plugins.c.status != "published",
                plugins.c.latest_release_id == 0,
            )
            .order_by(submissions.c.id)
        ).mappings()
    )
    counts = Counter(int(row["plugin_id"]) for row in rows)
    return [
        dict(row)
        for row in rows
        if counts[int(row["plugin_id"])] == 1
        and len(str(row["sha256"] or "")) == 64
        and bool(str(row["storage_key"] or ""))
        and bool(str(row["version"] or ""))
    ]


def _prepare_legacy_pending_sources(
    bind: sa.Connection, rows: list[dict[str, Any]]
) -> None:
    """Turn unpublished legacy targets into personal source identities."""
    if not rows:
        return
    plugins = sa.Table("plugins", sa.MetaData(), autoload_with=bind)
    for row in rows:
        owner_user_id = int(row["previous_owner_user_id"] or 0) or int(
            row["submitter_user_id"]
        )
        bind.execute(
            plugins.update()
            .where(plugins.c.id == row["plugin_id"])
            .values(visibility="personal", owner_user_id=owner_user_id)
        )


def _assert_catalog_namespace_uniqueness(bind: sa.Connection) -> None:
    plugins = sa.Table("plugins", sa.MetaData(), autoload_with=bind)
    duplicates = list(
        bind.execute(
            sa.select(
                plugins.c.catalog_namespace,
                plugins.c.slug,
                sa.func.count().label("row_count"),
            )
            .group_by(plugins.c.catalog_namespace, plugins.c.slug)
            .having(sa.func.count() > 1)
        ).mappings()
    )
    if duplicates:
        conflicts = ", ".join(
            f"{row['catalog_namespace']}:{row['slug']} ({row['row_count']})"
            for row in duplicates
        )
        raise RuntimeError(f"Plugin catalog namespace conflicts: {conflicts}")


def _assert_downgrade_slug_uniqueness(bind: sa.Connection) -> None:
    """Fail before mutation when the legacy global slug key cannot be restored.

    Once personal and enterprise identities share a slug, downgrade would either
    lose one identity or fail while recreating ``uniq_plugins_slug``. Operators
    must keep this migration applied, or explicitly archive/rename one side before
    retrying the downgrade.
    """
    plugins = sa.Table("plugins", sa.MetaData(), autoload_with=bind)
    duplicates = list(
        bind.execute(
            sa.select(plugins.c.slug, sa.func.count().label("row_count"))
            .group_by(plugins.c.slug)
            .having(sa.func.count() > 1)
        ).mappings()
    )
    if duplicates:
        conflicts = ", ".join(
            f"{row['slug']} ({row['row_count']} identities)" for row in duplicates
        )
        raise RuntimeError(
            "Plugin publication downgrade blocked before mutation: the legacy "
            "global slug constraint cannot represent namespace-separated "
            f"identities: {conflicts}. Keep revision c2f8d4a6b901 applied or "
            "archive/rename one conflicting identity before retrying."
        )


def _mark_legacy_enterprise_releases(bind: sa.Connection) -> None:
    metadata = sa.MetaData()
    plugins = sa.Table("plugins", metadata, autoload_with=bind)
    releases = sa.Table("plugin_releases", metadata, autoload_with=bind)
    rows = bind.execute(
        sa.select(releases.c.id, releases.c.scan_report_json)
        .select_from(releases.join(plugins, plugins.c.id == releases.c.plugin_id))
        .where(
            plugins.c.catalog_namespace == "enterprise",
            plugins.c.status == "published",
            releases.c.status == "ready",
        )
    ).mappings()
    for row in rows:
        report = dict(row["scan_report_json"] or {})
        if "provenance" in report:
            continue
        report["provenance"] = {"kind": "legacy_direct_publish"}
        bind.execute(
            releases.update()
            .where(releases.c.id == row["id"])
            .values(scan_report_json=report)
        )


def _migrate_legacy_pending_requests(
    bind: sa.Connection, rows: list[dict[str, Any]]
) -> None:
    if not rows:
        return
    metadata = sa.MetaData()
    requests = sa.Table("plugin_publication_requests", metadata, autoload_with=bind)
    revisions = sa.Table("plugin_publication_revisions", metadata, autoload_with=bind)
    events = sa.Table("plugin_publication_events", metadata, autoload_with=bind)
    submissions = sa.Table("plugin_submissions", metadata, autoload_with=bind)
    risk_declaration = {
        "externalNetworkAccess": False,
        "externalDomains": [],
        "executesCommands": False,
        "commandExamples": [],
        "readsOrWritesLocalFiles": False,
        "usesCredentials": False,
        "applicationPermissions": [],
        "additionalNotes": "",
    }
    for row in rows:
        submitted_at = row["submitted_at"] or datetime(1970, 1, 1)
        request_result = bind.execute(
            requests.insert().values(
                source_plugin_id=row["plugin_id"],
                submitter_user_id=row["submitter_user_id"],
                current_revision=1,
                aggregate_status="changes_requested",
                risk_level="none",
                submitted_at=submitted_at,
                created_at=submitted_at,
                updated_at=submitted_at,
            )
        )
        request_id = int(request_result.inserted_primary_key[0])
        revision_result = bind.execute(
            revisions.insert().values(
                request_id=request_id,
                revision=1,
                source_release_id=row["release_id"],
                requested_version=row["version"],
                snapshot_sha256=row["sha256"],
                source_tree_sha256="",
                storage_key=row["storage_key"],
                staging_storage_key="",
                filename=f"{row['slug']}-{row['version']}.zip",
                size_bytes=row["size_bytes"],
                manifest_snapshot=row["manifest_json"] or {},
                package_entries_json=[],
                package_entry_count=0,
                capabilities_json=[],
                risk_declaration=risk_declaration,
                release_notes="",
                test_notes="",
                source_updated_at=datetime(1970, 1, 1),
                status="changes_requested",
                created_by_user_id=row["submitter_user_id"],
                completed_at=submitted_at,
                created_at=submitted_at,
                updated_at=submitted_at,
            )
        )
        revision_id = int(revision_result.inserted_primary_key[0])
        bind.execute(
            requests.update()
            .where(requests.c.id == request_id)
            .values(current_revision_id=revision_id)
        )
        bind.execute(
            events.insert().values(
                revision_id=revision_id,
                event_type="migration.legacy_submission_imported",
                actor_type="system",
                message=(
                    "Legacy pending submission imported; create a new revision "
                    "with the current risk declaration"
                ),
                payload_json={
                    "submissionId": row["submission_id"],
                    "previousReviewNote": row["review_note"] or "",
                    "previousPluginVisibility": row["previous_visibility"],
                    "previousPluginOwnerUserId": row["previous_owner_user_id"],
                },
                external_event_id=(
                    f"migration:plugin_submission:{row['submission_id']}"
                ),
                created_at=submitted_at,
            )
        )
        bind.execute(
            submissions.update()
            .where(submissions.c.id == row["submission_id"])
            .values(
                status="cancelled",
                review_note="Migrated to enterprise publication request",
            )
        )


def _restore_migrated_legacy_submissions(bind: sa.Connection) -> None:
    metadata = sa.MetaData()
    events = sa.Table("plugin_publication_events", metadata, autoload_with=bind)
    revisions = sa.Table("plugin_publication_revisions", metadata, autoload_with=bind)
    submissions = sa.Table("plugin_submissions", metadata, autoload_with=bind)
    plugins = sa.Table("plugins", metadata, autoload_with=bind)
    rows = bind.execute(
        sa.select(
            revisions.c.request_id,
            events.c.payload_json,
        )
        .select_from(events.join(revisions, revisions.c.id == events.c.revision_id))
        .where(events.c.event_type == "migration.legacy_submission_imported")
    ).mappings()
    requests = sa.Table("plugin_publication_requests", metadata, autoload_with=bind)
    for row in rows:
        payload = dict(row["payload_json"] or {})
        submission_id = int(payload.get("submissionId") or 0)
        request = bind.execute(
            sa.select(requests.c.source_plugin_id).where(
                requests.c.id == row["request_id"]
            )
        ).first()
        if not submission_id or not request:
            continue
        bind.execute(
            submissions.update()
            .where(submissions.c.id == submission_id)
            .values(
                status="pending",
                review_note=str(payload.get("previousReviewNote") or ""),
            )
        )
        bind.execute(
            plugins.update()
            .where(plugins.c.id == request.source_plugin_id)
            .values(
                visibility=str(payload.get("previousPluginVisibility") or "workspace"),
                owner_user_id=int(payload.get("previousPluginOwnerUserId") or 0),
            )
        )


def _remove_legacy_release_markers(bind: sa.Connection) -> None:
    releases = sa.Table("plugin_releases", sa.MetaData(), autoload_with=bind)
    rows = bind.execute(
        sa.select(releases.c.id, releases.c.scan_report_json)
    ).mappings()
    for row in rows:
        report = dict(row["scan_report_json"] or {})
        if report.get("provenance") != {"kind": "legacy_direct_publish"}:
            continue
        report.pop("provenance", None)
        bind.execute(
            releases.update()
            .where(releases.c.id == row["id"])
            .values(scan_report_json=report)
        )


def upgrade() -> None:
    op.add_column(
        "plugins",
        sa.Column(
            "catalog_namespace",
            sa.String(100),
            nullable=False,
            server_default="enterprise",
            comment="Server-owned catalog namespace for stable plugin identity",
        ),
    )
    op.add_column(
        "plugins",
        sa.Column(
            "origin_plugin_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Source personal plugin ID; 0 means no linked origin",
        ),
    )
    bind = op.get_bind()
    legacy_pending_rows = _legacy_pending_candidates(bind)
    _prepare_legacy_pending_sources(bind, legacy_pending_rows)
    if bind.dialect.name == "mysql":
        op.execute(
            sa.text(
                """
                UPDATE plugins
                SET catalog_namespace = CASE
                    WHEN visibility = 'personal' AND owner_user_id <> 0
                        THEN CONCAT('personal/', owner_user_id)
                    WHEN visibility = 'public' AND owner_user_id = 0
                        THEN 'wework-official'
                    ELSE 'enterprise'
                END
                """
            )
        )
    else:
        op.execute(
            sa.text(
                """
                UPDATE plugins
                SET catalog_namespace = CASE
                    WHEN visibility = 'personal' AND owner_user_id <> 0
                        THEN 'personal/' || owner_user_id
                    WHEN visibility = 'public' AND owner_user_id = 0
                        THEN 'wework-official'
                    ELSE 'enterprise'
                END
                """
            )
        )
    _assert_catalog_namespace_uniqueness(bind)
    _mark_legacy_enterprise_releases(bind)
    op.drop_constraint("uniq_plugins_slug", "plugins", type_="unique")
    op.create_unique_constraint(
        "uniq_plugins_catalog_namespace_slug",
        "plugins",
        ["catalog_namespace", "slug"],
    )
    op.create_index("idx_plugins_origin", "plugins", ["origin_plugin_id"])

    op.add_column(
        "plugin_releases",
        sa.Column(
            "publication_revision_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Publication revision that produced this release; 0 means none",
        ),
    )
    op.add_column(
        "plugin_releases",
        sa.Column(
            "source_commit_sha",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Protected source commit SHA; empty means not GitLab-published",
        ),
    )
    op.create_index(
        "idx_plugin_releases_publication",
        "plugin_releases",
        ["publication_revision_id"],
    )

    op.create_table(
        "plugin_publication_requests",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Publication request primary key",
        ),
        sa.Column(
            "source_plugin_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Source personal plugin ID",
        ),
        sa.Column(
            "target_plugin_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Published enterprise plugin ID; 0 until released",
        ),
        sa.Column(
            "submitter_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Request owner user ID",
        ),
        sa.Column(
            "current_revision_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Current publication revision ID",
        ),
        sa.Column(
            "current_revision",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="Current one-based revision number",
        ),
        sa.Column(
            "aggregate_status",
            sa.String(40),
            nullable=False,
            server_default="uploading",
            comment="Current publication workflow status",
        ),
        sa.Column(
            "risk_level",
            sa.String(20),
            nullable=False,
            server_default="none",
            comment="Current summarized risk level",
        ),
        sa.Column(
            "submitted_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="First immutable submission time; epoch means not completed",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
            ),
            comment="Last workflow update time",
        ),
        comment="Enterprise plugin publication request aggregates",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_publication_request_owner",
        "plugin_publication_requests",
        ["submitter_user_id", "aggregate_status", "updated_at"],
    )
    op.create_index(
        "idx_plugin_publication_request_source",
        "plugin_publication_requests",
        ["source_plugin_id", "aggregate_status"],
    )

    op.create_table(
        "plugin_publication_revisions",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Revision primary key",
        ),
        sa.Column(
            "request_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Owning request ID",
        ),
        sa.Column(
            "revision",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="One-based immutable revision number",
        ),
        sa.Column(
            "source_release_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Optional source personal release ID",
        ),
        sa.Column(
            "requested_version",
            sa.String(50),
            nullable=False,
            server_default="",
            comment="Requested enterprise version",
        ),
        sa.Column(
            "snapshot_sha256",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Immutable submitted artifact SHA-256",
        ),
        sa.Column(
            "source_tree_sha256",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Canonical immutable source-tree SHA-256",
        ),
        sa.Column(
            "storage_key",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Immutable snapshot object key",
        ),
        sa.Column(
            "staging_storage_key",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Temporary signed-upload object key",
        ),
        sa.Column(
            "filename",
            sa.String(255),
            nullable=False,
            server_default="plugin.zip",
            comment="Original artifact filename",
        ),
        sa.Column(
            "size_bytes",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Artifact size in bytes",
        ),
        sa.Column(
            "manifest_snapshot",
            sa.JSON(),
            nullable=False,
            comment="Parsed immutable manifest snapshot",
        ),
        sa.Column(
            "package_entries_json",
            sa.JSON(),
            nullable=False,
            comment="Safely bounded immutable package path inventory",
        ),
        sa.Column(
            "package_entry_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Full immutable package regular-file count",
        ),
        sa.Column(
            "capabilities_json",
            sa.JSON(),
            nullable=False,
            comment="Safely bounded immutable capability inventory",
        ),
        sa.Column(
            "risk_declaration",
            sa.JSON(),
            nullable=False,
            comment="User-submitted permission and risk declaration",
        ),
        sa.Column(
            "release_notes",
            sa.String(4096),
            nullable=False,
            server_default="",
            comment="Requested release notes",
        ),
        sa.Column(
            "test_notes",
            sa.String(4096),
            nullable=False,
            server_default="",
            comment="Submitter test notes",
        ),
        sa.Column(
            "source_updated_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Source content timestamp at packaging",
        ),
        sa.Column(
            "status",
            sa.String(40),
            nullable=False,
            server_default="uploading",
            comment="Revision workflow status",
        ),
        sa.Column(
            "gitlab_project_id",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Controlled GitLab project ID",
        ),
        sa.Column(
            "gitlab_project_url",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Controlled GitLab project URL",
        ),
        sa.Column(
            "source_branch",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="Controlled source branch",
        ),
        sa.Column(
            "merge_request_iid",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="GitLab merge request IID",
        ),
        sa.Column(
            "merge_request_url",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="GitLab merge request URL",
        ),
        sa.Column(
            "merge_request_status",
            sa.String(40),
            nullable=False,
            server_default="",
            comment="Last observed merge request status",
        ),
        sa.Column(
            "pipeline_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Last observed pipeline ID",
        ),
        sa.Column(
            "pipeline_url",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Last observed pipeline URL",
        ),
        sa.Column(
            "pipeline_status",
            sa.String(40),
            nullable=False,
            server_default="",
            comment="Last observed pipeline status",
        ),
        sa.Column(
            "commit_sha",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Materialized source commit SHA",
        ),
        sa.Column(
            "created_by_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Revision creator user ID",
        ),
        sa.Column(
            "completed_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Snapshot completion time; epoch means incomplete",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
            ),
            comment="Last workflow update time",
        ),
        sa.UniqueConstraint(
            "request_id", "revision", name="uniq_plugin_publication_revision"
        ),
        comment="Immutable enterprise publication snapshots",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_publication_revision_status",
        "plugin_publication_revisions",
        ["status", "updated_at"],
    )
    op.create_index(
        "idx_plugin_publication_revision_gitlab",
        "plugin_publication_revisions",
        ["gitlab_project_id", "merge_request_iid"],
    )

    op.create_table(
        "plugin_publication_checks",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Check primary key",
        ),
        sa.Column(
            "revision_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Checked revision ID",
        ),
        sa.Column(
            "stage",
            sa.String(40),
            nullable=False,
            server_default="automatic",
            comment="Check stage",
        ),
        sa.Column(
            "check_code",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Stable check code",
        ),
        sa.Column(
            "title",
            sa.String(200),
            nullable=False,
            server_default="",
            comment="Human-readable check title",
        ),
        sa.Column(
            "severity",
            sa.String(20),
            nullable=False,
            server_default="info",
            comment="info, warning, or blocker",
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="pending",
            comment="Check execution status",
        ),
        sa.Column(
            "summary",
            sa.String(1000),
            nullable=False,
            server_default="",
            comment="Short check result summary",
        ),
        sa.Column(
            "evidence_json",
            sa.JSON(),
            nullable=False,
            comment="Structured evidence list",
        ),
        sa.Column(
            "execution_environment",
            sa.String(100),
            nullable=False,
            server_default="backend",
            comment="Execution environment label",
        ),
        sa.Column(
            "job_url",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="External job URL; empty means local check",
        ),
        sa.Column(
            "acknowledgement_required",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Whether an admin must acknowledge this warning",
        ),
        sa.Column(
            "acknowledged",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Whether the warning was acknowledged",
        ),
        sa.Column(
            "acknowledged_by_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Acknowledging admin user ID; 0 means none",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
            ),
            comment="Last check update time",
        ),
        sa.UniqueConstraint(
            "revision_id", "check_code", name="uniq_plugin_publication_check"
        ),
        comment="Publication check evidence by stable code",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_publication_check_status",
        "plugin_publication_checks",
        ["revision_id", "status"],
    )

    op.create_table(
        "plugin_publication_events",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Event primary key",
        ),
        sa.Column(
            "revision_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Related revision ID",
        ),
        sa.Column(
            "event_type",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Stable event type",
        ),
        sa.Column(
            "actor_type",
            sa.String(30),
            nullable=False,
            server_default="system",
            comment="user, admin, gitlab, pipeline, release_service, or system",
        ),
        sa.Column(
            "actor_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Actor user or service ID; 0 means external/system",
        ),
        sa.Column(
            "actor_name",
            sa.String(200),
            nullable=False,
            server_default="",
            comment="Human-readable actor name",
        ),
        sa.Column(
            "message",
            sa.String(1000),
            nullable=False,
            server_default="",
            comment="Human-readable audit message",
        ),
        sa.Column(
            "payload_json",
            sa.JSON(),
            nullable=False,
            comment="Structured event payload",
        ),
        sa.Column(
            "external_event_id",
            sa.String(200),
            nullable=False,
            server_default="",
            comment="Unique idempotency key for internal or external events",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.UniqueConstraint(
            "external_event_id", name="uniq_plugin_publication_external_event"
        ),
        comment="Append-only publication workflow audit events",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_publication_event_timeline",
        "plugin_publication_events",
        ["revision_id", "created_at"],
    )
    op.create_table(
        "plugin_release_idempotency",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Idempotency binding primary key",
        ),
        sa.Column(
            "idempotency_key",
            sa.String(81),
            nullable=False,
            server_default="",
            comment="Derived protected-pipeline release key",
        ),
        sa.Column(
            "request_sha256",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Canonical complete release envelope SHA256",
        ),
        sa.Column(
            "artifact_sha256",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Exact uploaded artifact SHA256",
        ),
        sa.Column(
            "envelope_json",
            sa.JSON(),
            nullable=False,
            comment="Complete validated release envelope",
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="processing",
            comment="processing, completed, or failed",
        ),
        sa.Column(
            "response_json",
            sa.JSON(),
            nullable=False,
            comment="Stable successful release response",
        ),
        sa.Column(
            "plugin_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Published enterprise plugin ID; 0 until completed",
        ),
        sa.Column(
            "release_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Published release ID; 0 until completed",
        ),
        sa.Column(
            "last_error",
            sa.String(1000),
            nullable=False,
            server_default="",
            comment="Last retriable release error",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
            ),
            comment="Last idempotency state update time",
        ),
        sa.UniqueConstraint(
            "idempotency_key", name="uniq_plugin_release_idempotency_key"
        ),
        comment="Durable protected-pipeline release idempotency bindings",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_release_idempotency_status",
        "plugin_release_idempotency",
        ["status", "updated_at"],
    )
    op.create_table(
        "plugin_publication_idempotency",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Idempotency binding primary key",
        ),
        sa.Column(
            "principal_type",
            sa.String(20),
            nullable=False,
            server_default="user",
            comment="Authenticated principal kind",
        ),
        sa.Column(
            "principal_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Authenticated principal ID",
        ),
        sa.Column(
            "operation",
            sa.String(80),
            nullable=False,
            server_default="",
            comment="Stable mutation operation name",
        ),
        sa.Column(
            "idempotency_key",
            sa.String(200),
            nullable=False,
            server_default="",
            comment="Caller-provided Idempotency-Key",
        ),
        sa.Column(
            "resource_key",
            sa.String(255),
            nullable=False,
            server_default="",
            comment="Operation-specific resource binding",
        ),
        sa.Column(
            "request_sha256",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Canonical resource and payload SHA256",
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="processing",
            comment="processing, completed, or failed",
        ),
        sa.Column(
            "response_json",
            sa.JSON(),
            nullable=False,
            comment="Completed response used for exact replay",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
            ),
            comment="Last idempotency state update time",
        ),
        sa.UniqueConstraint(
            "principal_type",
            "principal_id",
            "operation",
            "idempotency_key",
            name="uniq_plugin_publication_idempotency",
        ),
        comment="Durable publication workflow idempotency bindings",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_publication_idempotency_status",
        "plugin_publication_idempotency",
        ["status", "updated_at"],
    )
    _migrate_legacy_pending_requests(bind, legacy_pending_rows)


def downgrade() -> None:
    bind = op.get_bind()
    _assert_downgrade_slug_uniqueness(bind)
    _restore_migrated_legacy_submissions(bind)
    _remove_legacy_release_markers(bind)
    op.drop_table("plugin_publication_idempotency")
    op.drop_table("plugin_release_idempotency")
    op.drop_table("plugin_publication_events")
    op.drop_table("plugin_publication_checks")
    op.drop_table("plugin_publication_revisions")
    op.drop_table("plugin_publication_requests")

    op.drop_index("idx_plugin_releases_publication", table_name="plugin_releases")
    op.drop_column("plugin_releases", "source_commit_sha")
    op.drop_column("plugin_releases", "publication_revision_id")
    op.drop_index("idx_plugins_origin", table_name="plugins")
    op.drop_constraint("uniq_plugins_catalog_namespace_slug", "plugins", type_="unique")
    op.create_unique_constraint("uniq_plugins_slug", "plugins", ["slug"])
    op.drop_column("plugins", "origin_plugin_id")
    op.drop_column("plugins", "catalog_namespace")
