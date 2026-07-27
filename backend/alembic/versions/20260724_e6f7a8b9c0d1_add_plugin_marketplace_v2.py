# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add plugin marketplace v2 control-plane tables

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-07-24
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e6f7a8b9c0d1"
down_revision: Union[str, Sequence[str], None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bigint() -> sa.types.TypeEngine:
    return sa.BigInteger().with_variant(sa.Integer, "sqlite")


def _kind_fk() -> sa.types.TypeEngine:
    return sa.Integer()


def upgrade() -> None:
    op.create_table(
        "plugins",
        sa.Column("id", _bigint(), primary_key=True, autoincrement=True),
        sa.Column("slug", sa.String(100), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=False),
        sa.Column("summary", sa.String(500), nullable=False, server_default=""),
        sa.Column("description_md", sa.Text(), nullable=False),
        sa.Column("listing_type", sa.String(20), nullable=False),
        sa.Column("source_type", sa.String(20), nullable=False),
        sa.Column("source_provider", sa.String(50), nullable=False),
        sa.Column("owner_user_id", _bigint(), nullable=True),
        sa.Column("category", sa.String(50), nullable=False, server_default=""),
        sa.Column("keywords_json", sa.JSON(), nullable=False),
        sa.Column("interface_json", sa.JSON(), nullable=False),
        sa.Column("visibility", sa.String(20), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("latest_release_id", _bigint(), nullable=True),
        sa.Column("featured_rank", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("slug", name="uq_plugins_slug"),
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
        sa.Column("id", _bigint(), primary_key=True, autoincrement=True),
        sa.Column(
            "plugin_id",
            _bigint(),
            sa.ForeignKey("plugins.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version", sa.String(50), nullable=False),
        sa.Column("manifest_json", sa.JSON(), nullable=False),
        sa.Column("interface_json", sa.JSON(), nullable=False),
        sa.Column("release_notes", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.String(500), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size_bytes", _bigint(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("scan_status", sa.String(20), nullable=False),
        sa.Column("scan_report_json", sa.JSON(), nullable=False),
        sa.Column("created_by_user_id", _bigint(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("plugin_id", "version", name="uniq_plugin_release_version"),
    )
    op.create_index(
        "idx_plugin_releases_status",
        "plugin_releases",
        ["plugin_id", "status", "published_at"],
    )
    op.create_index("idx_plugin_releases_sha256", "plugin_releases", ["sha256"])

    op.create_table(
        "plugin_upstreams",
        sa.Column("id", _bigint(), primary_key=True, autoincrement=True),
        sa.Column(
            "plugin_id",
            _bigint(),
            sa.ForeignKey("plugins.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("marketplace_name", sa.String(100), nullable=False),
        sa.Column("remote_plugin_id", sa.String(200), nullable=False),
        sa.Column("upstream_url", sa.String(500), nullable=False, server_default=""),
        sa.Column("license_info", sa.String(500), nullable=False, server_default=""),
        sa.Column(
            "sync_enabled", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("sync_policy", sa.String(30), nullable=False),
        sa.Column("last_seen_version", sa.String(50), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.String(1000), nullable=True),
        sa.UniqueConstraint(
            "provider",
            "marketplace_name",
            "remote_plugin_id",
            name="uniq_plugin_upstream_source",
        ),
    )
    op.create_index(
        "idx_plugin_upstreams_sync",
        "plugin_upstreams",
        ["sync_enabled", "provider"],
    )

    op.create_table(
        "plugin_submissions",
        sa.Column("id", _bigint(), primary_key=True, autoincrement=True),
        sa.Column(
            "plugin_id",
            _bigint(),
            sa.ForeignKey("plugins.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "release_id",
            _bigint(),
            sa.ForeignKey("plugin_releases.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("submitter_user_id", _bigint(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("reviewer_user_id", _bigint(), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=False),
        sa.Column("submitted_at", sa.DateTime(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("release_id", name="uniq_plugin_submission_release"),
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
        sa.Column("id", _bigint(), primary_key=True, autoincrement=True),
        sa.Column(
            "installed_kind_id",
            _kind_fk(),
            sa.ForeignKey("kinds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", _bigint(), nullable=False),
        sa.Column("device_id", sa.String(100), nullable=False),
        sa.Column(
            "desired_release_id",
            _bigint(),
            sa.ForeignKey("plugin_releases.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "actual_release_id",
            _bigint(),
            sa.ForeignKey("plugin_releases.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("error_code", sa.String(100), nullable=True),
        sa.Column("error_message", sa.String(1000), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_sync_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            "installed_kind_id",
            "device_id",
            name="uniq_plugin_device_installation",
        ),
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
