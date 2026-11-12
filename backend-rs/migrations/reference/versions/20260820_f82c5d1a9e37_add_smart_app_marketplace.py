"""Add Smart app marketplace control-plane tables.

Revision ID: f82c5d1a9e37
Revises: d47dd270f4b6
Create Date: 2026-08-20

The schema follows the production DB audit rules: every column has a comment,
every non-primary column is NOT NULL with an explicit default, optional times
use the epoch sentinel, JSON defaults use MySQL expression syntax, and indexes
use the required uniq_ / idx_ prefixes.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "f82c5d1a9e37"
down_revision: Union[str, Sequence[str], None] = "d47dd270f4b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_EPOCH = "1970-01-01 00:00:00.000000"


def _bigint() -> sa.types.TypeEngine:
    return sa.BigInteger().with_variant(sa.Integer, "sqlite")


def _datetime() -> sa.types.TypeEngine:
    return sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def _timestamp_default(*, on_update: bool = False) -> sa.TextClause:
    if op.get_bind().dialect.name == "sqlite":
        return sa.text("CURRENT_TIMESTAMP")
    value = "CURRENT_TIMESTAMP(6)"
    if on_update:
        value += " ON UPDATE CURRENT_TIMESTAMP(6)"
    return sa.text(value)


def _json_default(value: str) -> sa.TextClause:
    return sa.text(f"('{value}')")


def upgrade() -> None:
    op.create_table(
        "smart_apps",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Smart app primary key",
        ),
        sa.Column(
            "owner_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Owner user ID; 0 means platform-owned official app",
        ),
        sa.Column(
            "name",
            sa.String(100),
            nullable=False,
            server_default="",
            comment="Canonical Smart app name from manifest",
        ),
        sa.Column(
            "display_name",
            sa.String(200),
            nullable=False,
            server_default="",
            comment="Human-readable Smart app title",
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
            comment="Markdown marketplace description, limited to 8192 characters",
        ),
        sa.Column(
            "source_type",
            sa.String(20),
            nullable=False,
            server_default="user",
            comment="Publisher source: official or user",
        ),
        sa.Column(
            "visibility",
            sa.String(20),
            nullable=False,
            server_default="restricted",
            comment="Distribution scope: public, restricted, or private",
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="draft",
            comment="Catalog lifecycle status: draft or published",
        ),
        sa.Column(
            "tags_json",
            sa.JSON(),
            nullable=False,
            server_default=_json_default("[]"),
            comment="Marketplace tag IDs as a JSON array",
        ),
        sa.Column(
            "icon_storage_key",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Object-storage key for the active icon",
        ),
        sa.Column(
            "screenshots_json",
            sa.JSON(),
            nullable=False,
            server_default=_json_default("[]"),
            comment="Object-storage keys for screenshots as a JSON array",
        ),
        sa.Column(
            "extensions_json",
            sa.JSON(),
            nullable=False,
            server_default=_json_default("{}"),
            comment="Versioned namespaced application extension fields",
        ),
        sa.Column(
            "latest_release_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Latest published release ID; 0 means no release",
        ),
        sa.Column(
            "featured_rank",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Marketplace featured rank; 0 means not featured",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=_timestamp_default(),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=_timestamp_default(on_update=True),
            comment="Last update time",
        ),
        sa.Column(
            "published_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="First publish time; epoch means unpublished",
        ),
        sa.UniqueConstraint("owner_user_id", "name", name="uniq_smart_app_owner_name"),
        comment="Smart app marketplace catalog identities",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_smart_apps_catalog",
        "smart_apps",
        ["status", "source_type", "featured_rank"],
    )
    op.create_table(
        "smart_app_releases",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Smart app release primary key",
        ),
        sa.Column(
            "smart_app_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Owning Smart app ID; logical reference without database foreign key",
        ),
        sa.Column(
            "version",
            sa.String(50),
            nullable=False,
            server_default="",
            comment="Immutable semantic version",
        ),
        sa.Column(
            "manifest_json",
            sa.JSON(),
            nullable=False,
            server_default=_json_default("{}"),
            comment="Validated immutable runtime manifest snapshot",
        ),
        sa.Column(
            "release_notes",
            sa.String(4096),
            nullable=False,
            server_default="",
            comment="Release notes, limited to 4096 characters",
        ),
        sa.Column(
            "storage_key",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Immutable package object-storage key",
        ),
        sa.Column(
            "sha256",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Lowercase package SHA-256 hex digest",
        ),
        sa.Column(
            "size_bytes",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Package size in bytes",
        ),
        sa.Column(
            "scan_status",
            sa.String(20),
            nullable=False,
            server_default="passed",
            comment="Security scan status: passed or failed",
        ),
        sa.Column(
            "scan_report_json",
            sa.JSON(),
            nullable=False,
            server_default=_json_default("{}"),
            comment="Security scan report snapshot",
        ),
        sa.Column(
            "extensions_json",
            sa.JSON(),
            nullable=False,
            server_default=_json_default("{}"),
            comment="Versioned namespaced release extension fields",
        ),
        sa.Column(
            "created_by_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Publisher user ID; 0 means official publisher",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=_timestamp_default(),
            comment="Creation time",
        ),
        sa.Column(
            "published_at",
            _datetime(),
            nullable=False,
            server_default=_timestamp_default(),
            comment="Release publish time",
        ),
        sa.UniqueConstraint(
            "smart_app_id", "version", name="uniq_smart_app_release_version"
        ),
        comment="Immutable Smart app package releases",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_smart_app_releases_app",
        "smart_app_releases",
        ["smart_app_id", "published_at"],
    )
    op.create_table(
        "smart_app_submissions",
        sa.Column(
            "id",
            _bigint(),
            primary_key=True,
            autoincrement=True,
            comment="Smart app submission primary key",
        ),
        sa.Column(
            "smart_app_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Target Smart app ID; logical reference without database foreign key",
        ),
        sa.Column(
            "owner_user_id",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Submitting owner user ID",
        ),
        sa.Column(
            "version",
            sa.String(50),
            nullable=False,
            server_default="",
            comment="Submitted semantic version",
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="uploading",
            comment="Submission status: uploading, scanning, published, rejected, or cancelled",
        ),
        sa.Column(
            "staging_storage_key",
            sa.String(500),
            nullable=False,
            server_default="",
            comment="Temporary package object-storage key",
        ),
        sa.Column(
            "sha256",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Expected lowercase package SHA-256 hex digest",
        ),
        sa.Column(
            "size_bytes",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Expected package size in bytes",
        ),
        sa.Column(
            "metadata_json",
            sa.JSON(),
            nullable=False,
            server_default=_json_default("{}"),
            comment="Submission listing, asset, recipient, and extension snapshot",
        ),
        sa.Column(
            "error_message",
            sa.String(1000),
            nullable=False,
            server_default="",
            comment="Rejected submission error; empty means no error",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=_timestamp_default(),
            comment="Creation time",
        ),
        sa.Column(
            "updated_at",
            _datetime(),
            nullable=False,
            server_default=_timestamp_default(on_update=True),
            comment="Last update time",
        ),
        comment="Two-phase Smart app publication submissions",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_smart_app_submissions_owner",
        "smart_app_submissions",
        ["owner_user_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("idx_smart_app_submissions_owner", table_name="smart_app_submissions")
    op.drop_table("smart_app_submissions")
    op.drop_index("idx_smart_app_releases_app", table_name="smart_app_releases")
    op.drop_table("smart_app_releases")
    op.drop_index("idx_smart_apps_catalog", table_name="smart_apps")
    op.drop_table("smart_apps")
