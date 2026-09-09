# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Relational models for the Wework plugin marketplace control plane."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
    event,
    inspect,
)
from sqlalchemy.dialects import mysql

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

# Sentinel for optional datetime columns (DB NOT NULL DEFAULT epoch).
EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)

_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def unset_id(value: int | None) -> int | None:
    """Map DB ID sentinel 0 back to API null."""
    if value is None or value == 0:
        return None
    return value


def unset_str(value: str | None) -> str | None:
    """Map DB empty-string sentinel back to API null."""
    if value is None or value == "":
        return None
    return value


def unset_datetime(value: datetime | None) -> datetime | None:
    """Map DB epoch sentinel back to API null."""
    if value is None or value == EPOCH_TIME:
        return None
    return value


def is_featured_rank(value: int | None) -> bool:
    """Whether featured_rank represents an active featured listing."""
    return bool(value)


class Plugin(Base):
    """Stable marketplace identity independent from any single release."""

    __tablename__ = "plugins"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Plugin primary key",
    )
    catalog_namespace = Column(
        String(100),
        nullable=False,
        default="enterprise",
        server_default="enterprise",
        comment="Server-owned catalog namespace for stable plugin identity",
    )
    slug = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Stable unique marketplace slug",
    )
    name = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Canonical plugin name from manifest",
    )
    display_name = Column(
        String(200),
        nullable=False,
        default="",
        server_default="",
        comment="Human-readable plugin title",
    )
    summary = Column(
        String(500),
        nullable=False,
        default="",
        server_default="",
        comment="Short marketplace summary",
    )
    description_md = Column(
        String(8192),
        nullable=False,
        default="",
        server_default="",
        comment="Markdown description; empty means unset",
    )
    listing_type = Column(
        String(20),
        nullable=False,
        default="plugin",
        server_default="plugin",
        comment="Listing type: plugin or skill",
    )
    source_type = Column(
        String(20),
        nullable=False,
        default="native",
        server_default="native",
        comment="Source type: native, mirror, or submission",
    )
    source_provider = Column(
        String(50),
        nullable=False,
        default="wework",
        server_default="wework",
        comment="Source provider label, e.g. wework or codex",
    )
    owner_user_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Owner user ID; 0 means platform-owned / unset",
    )
    origin_plugin_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Source personal plugin ID; 0 means no linked origin",
    )
    category = Column(
        String(50),
        nullable=False,
        default="",
        server_default="",
        comment="Marketplace category; empty means unset",
    )
    keywords_json = Column(
        JSON,
        nullable=False,
        default=list,
        comment="Search keywords JSON array; app writes [] when unset",
    )
    interface_json = Column(
        JSON,
        nullable=False,
        default=dict,
        comment="Composer/UI interface metadata JSON object; app writes {} when unset",
    )
    visibility = Column(
        String(20),
        nullable=False,
        default="workspace",
        server_default="workspace",
        comment="Visibility: personal, workspace, or public",
    )
    allow_copy = Column(
        Boolean,
        nullable=False,
        default=False,
        server_default="0",
        comment="Whether recipients may copy the plugin",
    )
    status = Column(
        String(30),
        nullable=False,
        default="draft",
        server_default="draft",
        comment="Lifecycle status: draft, published, etc.",
    )
    latest_release_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Latest ready release ID; 0 means none",
    )
    featured_rank = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Featured sort rank; 0 means not featured",
    )
    created_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        comment="Creation time",
    )
    updated_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
        comment="Last update time",
    )
    published_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
        comment="First publish time; epoch means unpublished",
    )

    __table_args__ = (
        UniqueConstraint(
            "catalog_namespace",
            "slug",
            name="uniq_plugins_catalog_namespace_slug",
        ),
        Index(
            "idx_plugins_discovery",
            "status",
            "visibility",
            "featured_rank",
        ),
        Index(
            "idx_plugins_listing_category",
            "listing_type",
            "category",
            "status",
        ),
        Index("idx_plugins_source", "source_provider", "source_type"),
        Index("idx_plugins_origin", "origin_plugin_id"),
        {
            "comment": "Marketplace plugin catalog identities",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginRelease(Base):
    """Immutable package and metadata snapshot for a marketplace plugin."""

    __tablename__ = "plugin_releases"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Release primary key",
    )
    plugin_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Owning plugin ID",
    )
    version = Column(
        String(50),
        nullable=False,
        default="",
        server_default="",
        comment="Semver release version",
    )
    manifest_json = Column(
        JSON,
        nullable=False,
        default=dict,
        comment="Parsed package manifest JSON object; app writes {} when unset",
    )
    interface_json = Column(
        JSON,
        nullable=False,
        default=dict,
        comment="Release interface metadata JSON object; app writes {} when unset",
    )
    release_notes = Column(
        String(4096),
        nullable=False,
        default="",
        server_default="",
        comment="Release notes; empty means unset",
    )
    storage_key = Column(
        String(500),
        nullable=False,
        default="",
        server_default="",
        comment="Object storage key for the package zip",
    )
    sha256 = Column(
        String(64),
        nullable=False,
        default="",
        server_default="",
        comment="Package content SHA-256 hex digest",
    )
    size_bytes = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Package size in bytes",
    )
    status = Column(
        String(20),
        nullable=False,
        default="processing",
        server_default="processing",
        comment="Release status: processing, ready, rejected, etc.",
    )
    scan_status = Column(
        String(20),
        nullable=False,
        default="pending",
        server_default="pending",
        comment="Security scan status: pending, passed, failed",
    )
    scan_report_json = Column(
        JSON,
        nullable=False,
        default=dict,
        comment="Security scan report JSON object; app writes {} when unset",
    )
    created_by_user_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Creator user ID; 0 means system / unset",
    )
    publication_revision_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Publication revision that produced this release; 0 means none",
    )
    source_commit_sha = Column(
        String(64),
        nullable=False,
        default="",
        server_default="",
        comment="Protected source commit SHA; empty means not GitLab-published",
    )
    created_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        comment="Creation time",
    )
    published_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
        comment="Publish time; epoch means unpublished",
    )

    __table_args__ = (
        UniqueConstraint("plugin_id", "version", name="uniq_plugin_release_version"),
        Index("idx_plugin_releases_status", "plugin_id", "status", "published_at"),
        Index("idx_plugin_releases_sha256", "sha256"),
        Index("idx_plugin_releases_publication", "publication_revision_id"),
        {
            "comment": "Immutable marketplace plugin release packages",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginUpstream(Base):
    """Selective upstream mirror configuration for one catalog plugin."""

    __tablename__ = "plugin_upstreams"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Upstream primary key",
    )
    plugin_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Mirrored local plugin ID",
    )
    provider = Column(
        String(50),
        nullable=False,
        default="codex",
        server_default="codex",
        comment="Upstream provider, e.g. codex",
    )
    marketplace_name = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Remote marketplace name",
    )
    remote_plugin_id = Column(
        String(200),
        nullable=False,
        default="",
        server_default="",
        comment="Remote plugin identifier",
    )
    upstream_url = Column(
        String(500),
        nullable=False,
        default="",
        server_default="",
        comment="Package download URL",
    )
    license_info = Column(
        String(500),
        nullable=False,
        default="",
        server_default="",
        comment="Upstream license summary; empty means unset",
    )
    sync_enabled = Column(
        Boolean,
        nullable=False,
        default=True,
        server_default="1",
        comment="Whether automatic sync is enabled",
    )
    sync_policy = Column(
        String(30),
        nullable=False,
        default="auto_after_scan",
        server_default="auto_after_scan",
        comment="Sync policy: auto_after_scan or review_required",
    )
    last_seen_version = Column(
        String(50),
        nullable=False,
        default="",
        server_default="",
        comment="Last observed remote version; empty means none",
    )
    last_checked_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
        comment="Last check time; epoch means never checked",
    )
    last_synced_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
        comment="Last successful sync time; epoch means never synced",
    )
    last_error = Column(
        String(1000),
        nullable=False,
        default="",
        server_default="",
        comment="Last sync error message; empty means no error",
    )

    __table_args__ = (
        UniqueConstraint("plugin_id", name="uniq_plugin_upstreams_plugin_id"),
        UniqueConstraint(
            "provider",
            "marketplace_name",
            "remote_plugin_id",
            name="uniq_plugin_upstream_source",
        ),
        Index("idx_plugin_upstreams_sync", "sync_enabled", "provider"),
        {
            "comment": "Selective upstream mirror configuration",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginSubmission(Base):
    """Reviewable request to publish one immutable plugin release."""

    __tablename__ = "plugin_submissions"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Submission primary key",
    )
    plugin_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Target plugin ID",
    )
    release_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Submitted release ID",
    )
    submitter_user_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Submitter user ID",
    )
    purpose = Column(
        String(30),
        nullable=False,
        default="marketplace_publish",
        server_default="marketplace_publish",
        comment="Submission purpose",
    )
    status = Column(
        String(20),
        nullable=False,
        default="uploading",
        server_default="uploading",
        comment="Review status: uploading, pending, approved, rejected",
    )
    reviewer_user_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Reviewer user ID; 0 means not reviewed",
    )
    review_note = Column(
        String(2000),
        nullable=False,
        default="",
        server_default="",
        comment="Reviewer note; empty means unset",
    )
    submitted_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        comment="Submission time",
    )
    reviewed_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
        comment="Review time; epoch means not reviewed",
    )

    __table_args__ = (
        UniqueConstraint("release_id", name="uniq_plugin_submission_release"),
        Index("idx_plugin_submissions_queue", "status", "submitted_at"),
        Index("idx_plugin_submissions_submitter", "submitter_user_id", "status"),
        {
            "comment": "Marketplace plugin publish review requests",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginDeviceInstallation(Base):
    """Materialized installation state for one account installation and device."""

    __tablename__ = "plugin_device_installations"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Device installation primary key",
    )
    installed_kind_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="InstalledPlugin kinds.id",
    )
    user_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Account owner user ID",
    )
    device_id = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Target device identifier",
    )
    desired_release_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Desired release ID for the device",
    )
    actual_release_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Actually installed release ID; 0 means none",
    )
    state = Column(
        String(20),
        nullable=False,
        default="pending",
        server_default="pending",
        comment="Install state: pending, installed, failed, etc.",
    )
    error_code = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Last error code; empty means no error",
    )
    error_message = Column(
        String(1000),
        nullable=False,
        default="",
        server_default="",
        comment="Last error message; empty means no error",
    )
    attempt_count = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Sync attempt count",
    )
    last_sync_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
        comment="Last sync time; epoch means never synced",
    )
    updated_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
        comment="Last update time",
    )

    __table_args__ = (
        UniqueConstraint(
            "installed_kind_id",
            "device_id",
            name="uniq_plugin_device_installation",
        ),
        Index("idx_plugin_device_user_state", "user_id", "state"),
        Index("idx_plugin_device_device", "device_id", "updated_at"),
        {
            "comment": "Per-device materialization of installed plugin state",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


@event.listens_for(PluginRelease, "before_update")
def prevent_published_release_mutation(mapper, connection, target) -> None:
    """Keep the package and manifest immutable after a release becomes ready."""
    del mapper, connection
    state = inspect(target)
    status_history = state.attrs.status.history
    previous_status = status_history.deleted
    was_ready = bool(previous_status and previous_status[0] == "ready") or (
        not status_history.has_changes() and target.status == "ready"
    )
    if not was_ready and target.status != "ready":
        return
    immutable_fields = (
        "plugin_id",
        "version",
        "manifest_json",
        "interface_json",
        "storage_key",
        "sha256",
        "size_bytes",
        "scan_report_json",
        "created_by_user_id",
        "publication_revision_id",
        "source_commit_sha",
        "published_at",
    )
    changed = [
        field for field in immutable_fields if state.attrs[field].history.has_changes()
    ]
    if was_ready and changed:
        raise ValueError(
            f"Published plugin release fields are immutable: {', '.join(changed)}"
        )
