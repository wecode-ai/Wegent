# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add plugin marketplace v2 control-plane tables

Revision ID: d4e5f6a7b8c9
Revises: b9c0d1e2f3a4
Create Date: 2026-08-04

Squashed from the feature-branch chain that previously created the marketplace
tables, renamed source_provider values, and added restricted-sharing columns.
Fresh installs get the final schema in one revision.

Schema follows production DB audit rules: every column has COMMENT, non-PK
columns are NOT NULL with explicit DEFAULT (JSON columns intentionally omit
DEFAULT per DBA guidance; the app always writes []/{}), no ENUM, no foreign
keys, no table/column collation overrides, unique indexes use uniq_ prefix,
and optional API values use sentinels (0 / '' / 1970-01-01 00:00:00.000000).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, Sequence[str], None] = "b9c0d1e2f3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_EPOCH = "1970-01-01 00:00:00.000000"


def _bigint() -> sa.types.TypeEngine:
    return sa.BigInteger().with_variant(sa.Integer, "sqlite")


def _datetime() -> sa.types.TypeEngine:
    return sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def upgrade() -> None:
    op.create_table(
        "plugins",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Plugin primary key",
        ),
        sa.Column(
            "slug",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Stable unique marketplace slug",
        ),
        sa.Column(
            "name",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Canonical plugin name from manifest",
        ),
        sa.Column(
            "display_name",
            sa.String(200),
            nullable=False,
            server_default="",
            comment="Human-readable plugin title",
        ),
        sa.Column(
            "summary",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Short marketplace summary",
        ),
        sa.Column(
            "description_md",
            sa.String(8192),
            nullable=False,
            server_default="",
            comment="Markdown description; empty means unset",
        ),
        sa.Column(
            "listing_type",
            sa.String(20),
            nullable=False,
            server_default="plugin",
            comment="Listing type: plugin or skill",
        ),
        sa.Column(
            "source_type",
            sa.String(20),
            nullable=False,
            server_default="native",
            comment="Source type: native, mirror, or submission",
        ),
        sa.Column(
            "source_provider",
            sa.String(50),
            nullable=False,
            server_default="wework",
            comment="Source provider label, e.g. wework or codex",
        ),
        sa.Column(
            "owner_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Owner user ID; 0 means platform-owned / unset",
        ),
        sa.Column(
            "category",
            sa.String(50),
            nullable=False,
            server_default="",
            comment="Marketplace category; empty means unset",
        ),
        sa.Column(
            "keywords_json",
            sa.JSON(),
            nullable=False,
            comment="Search keywords JSON array; app writes [] when unset",
        ),
        sa.Column(
            "interface_json",
            sa.JSON(),
            nullable=False,
            comment="Composer/UI interface metadata JSON object; app writes {} when unset",
        ),
        sa.Column(
            "visibility",
            sa.String(20),
            nullable=False,
            server_default="workspace",
            comment="Visibility: personal, workspace, or public",
        ),
        sa.Column(
            "allow_copy",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Whether recipients may copy the plugin",
        ),
        sa.Column(
            "status",
            sa.String(30),
            nullable=False,
            server_default="draft",
            comment="Lifecycle status: draft, published, etc.",
        ),
        sa.Column(
            "latest_release_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Latest ready release ID; 0 means none",
        ),
        sa.Column(
            "featured_rank",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Featured sort rank; 0 means not featured",
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
            comment="Last update time",
        ),
        sa.Column(
            "published_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="First publish time; epoch means unpublished",
        ),
        sa.UniqueConstraint("slug", name="uniq_plugins_slug"),
        comment="Marketplace plugin catalog identities",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugins_discovery",
        "plugins",
        ["status", "visibility", "featured_rank"],
    )
    op.create_index(
        "idx_plugins_listing_category",
        "plugins",
        ["listing_type", "category", "status"],
    )
    op.create_index("idx_plugins_source", "plugins", ["source_provider", "source_type"])

    op.create_table(
        "plugin_releases",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Release primary key",
        ),
        sa.Column(
            "plugin_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Owning plugin ID",
        ),
        sa.Column(
            "version",
            sa.String(50),
            nullable=False,
            server_default="",
            comment="Semver release version",
        ),
        sa.Column(
            "manifest_json",
            sa.JSON(),
            nullable=False,
            comment="Parsed package manifest JSON object; app writes {} when unset",
        ),
        sa.Column(
            "interface_json",
            sa.JSON(),
            nullable=False,
            comment="Release interface metadata JSON object; app writes {} when unset",
        ),
        sa.Column(
            "release_notes",
            sa.String(4096),
            nullable=False,
            server_default="",
            comment="Release notes; empty means unset",
        ),
        sa.Column(
            "storage_key",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Object storage key for the package zip",
        ),
        sa.Column(
            "sha256",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Package content SHA-256 hex digest",
        ),
        sa.Column(
            "size_bytes",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Package size in bytes",
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="processing",
            comment="Release status: processing, ready, rejected, etc.",
        ),
        sa.Column(
            "scan_status",
            sa.String(20),
            nullable=False,
            server_default="pending",
            comment="Security scan status: pending, passed, failed",
        ),
        sa.Column(
            "scan_report_json",
            sa.JSON(),
            nullable=False,
            comment="Security scan report JSON object; app writes {} when unset",
        ),
        sa.Column(
            "created_by_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Creator user ID; 0 means system / unset",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Creation time",
        ),
        sa.Column(
            "published_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Publish time; epoch means unpublished",
        ),
        sa.UniqueConstraint("plugin_id", "version", name="uniq_plugin_release_version"),
        comment="Immutable marketplace plugin release packages",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_releases_status",
        "plugin_releases",
        ["plugin_id", "status", "published_at"],
    )
    op.create_index("idx_plugin_releases_sha256", "plugin_releases", ["sha256"])

    op.create_table(
        "plugin_upstreams",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Upstream primary key",
        ),
        sa.Column(
            "plugin_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Mirrored local plugin ID",
        ),
        sa.Column(
            "provider",
            sa.String(50),
            nullable=False,
            server_default="codex",
            comment="Upstream provider, e.g. codex",
        ),
        sa.Column(
            "marketplace_name",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Remote marketplace name",
        ),
        sa.Column(
            "remote_plugin_id",
            sa.String(200),
            nullable=False,
            server_default="",
            comment="Remote plugin identifier",
        ),
        sa.Column(
            "upstream_url",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Package download URL",
        ),
        sa.Column(
            "license_info",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Upstream license summary; empty means unset",
        ),
        sa.Column(
            "sync_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("1"),
            comment="Whether automatic sync is enabled",
        ),
        sa.Column(
            "sync_policy",
            sa.String(30),
            nullable=False,
            server_default="auto_after_scan",
            comment="Sync policy: auto_after_scan or review_required",
        ),
        sa.Column(
            "last_seen_version",
            sa.String(50),
            nullable=False,
            server_default="",
            comment="Last observed remote version; empty means none",
        ),
        sa.Column(
            "last_checked_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Last check time; epoch means never checked",
        ),
        sa.Column(
            "last_synced_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Last successful sync time; epoch means never synced",
        ),
        sa.Column(
            "last_error",
            sa.String(1000),
            nullable=False,
            server_default="",
            comment="Last sync error message; empty means no error",
        ),
        sa.UniqueConstraint("plugin_id", name="uniq_plugin_upstreams_plugin_id"),
        sa.UniqueConstraint(
            "provider",
            "marketplace_name",
            "remote_plugin_id",
            name="uniq_plugin_upstream_source",
        ),
        comment="Selective upstream mirror configuration",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_upstreams_sync",
        "plugin_upstreams",
        ["sync_enabled", "provider"],
    )

    op.create_table(
        "plugin_submissions",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Submission primary key",
        ),
        sa.Column(
            "plugin_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Target plugin ID",
        ),
        sa.Column(
            "release_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Submitted release ID",
        ),
        sa.Column(
            "submitter_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Submitter user ID",
        ),
        sa.Column(
            "purpose",
            sa.String(30),
            nullable=False,
            server_default="marketplace_publish",
            comment="Submission purpose",
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="uploading",
            comment="Review status: uploading, pending, approved, rejected",
        ),
        sa.Column(
            "reviewer_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Reviewer user ID; 0 means not reviewed",
        ),
        sa.Column(
            "review_note",
            sa.String(2000),
            nullable=False,
            server_default="",
            comment="Reviewer note; empty means unset",
        ),
        sa.Column(
            "submitted_at",
            _datetime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP(6)"),
            comment="Submission time",
        ),
        sa.Column(
            "reviewed_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Review time; epoch means not reviewed",
        ),
        sa.UniqueConstraint("release_id", name="uniq_plugin_submission_release"),
        comment="Marketplace plugin publish review requests",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_submissions_queue",
        "plugin_submissions",
        ["status", "submitted_at"],
    )
    op.create_index(
        "idx_plugin_submissions_submitter",
        "plugin_submissions",
        ["submitter_user_id", "status"],
    )

    op.create_table(
        "plugin_device_installations",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Device installation primary key",
        ),
        sa.Column(
            "installed_kind_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="InstalledPlugin kinds.id",
        ),
        sa.Column(
            "user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Account owner user ID",
        ),
        sa.Column(
            "device_id",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Target device identifier",
        ),
        sa.Column(
            "desired_release_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Desired release ID for the device",
        ),
        sa.Column(
            "actual_release_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Actually installed release ID; 0 means none",
        ),
        sa.Column(
            "state",
            sa.String(20),
            nullable=False,
            server_default="pending",
            comment="Install state: pending, installed, failed, etc.",
        ),
        sa.Column(
            "error_code",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Last error code; empty means no error",
        ),
        sa.Column(
            "error_message",
            sa.String(1000),
            nullable=False,
            server_default="",
            comment="Last error message; empty means no error",
        ),
        sa.Column(
            "attempt_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Sync attempt count",
        ),
        sa.Column(
            "last_sync_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Last sync time; epoch means never synced",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=sa.text(
                "CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"
            ),
            comment="Last update time",
        ),
        sa.UniqueConstraint(
            "installed_kind_id",
            "device_id",
            name="uniq_plugin_device_installation",
        ),
        comment="Per-device materialization of installed plugin state",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_plugin_device_user_state",
        "plugin_device_installations",
        ["user_id", "state"],
    )
    op.create_index(
        "idx_plugin_device_device",
        "plugin_device_installations",
        ["device_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_plugin_device_device", table_name="plugin_device_installations")
    op.drop_index(
        "idx_plugin_device_user_state", table_name="plugin_device_installations"
    )
    op.drop_table("plugin_device_installations")
    op.drop_index("idx_plugin_submissions_submitter", table_name="plugin_submissions")
    op.drop_index("idx_plugin_submissions_queue", table_name="plugin_submissions")
    op.drop_table("plugin_submissions")
    op.drop_index("idx_plugin_upstreams_sync", table_name="plugin_upstreams")
    op.drop_table("plugin_upstreams")
    op.drop_index("idx_plugin_releases_sha256", table_name="plugin_releases")
    op.drop_index("idx_plugin_releases_status", table_name="plugin_releases")
    op.drop_table("plugin_releases")
    op.drop_index("idx_plugins_source", table_name="plugins")
    op.drop_index("idx_plugins_listing_category", table_name="plugins")
    op.drop_index("idx_plugins_discovery", table_name="plugins")
    op.drop_table("plugins")
