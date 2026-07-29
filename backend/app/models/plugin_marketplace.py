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
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
    inspect,
)

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


class Plugin(Base):
    """Stable marketplace identity independent from any single release."""

    __tablename__ = "plugins"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    slug = Column(String(100), nullable=False, unique=True)
    name = Column(String(100), nullable=False)
    display_name = Column(String(200), nullable=False)
    summary = Column(String(500), nullable=False, default="", server_default="")
    description_md = Column(Text, nullable=False, default="")
    listing_type = Column(String(20), nullable=False, default="plugin")
    source_type = Column(String(20), nullable=False, default="native")
    source_provider = Column(String(50), nullable=False, default="wework")
    owner_user_id = Column(big_integer_id_type(), nullable=True)
    category = Column(String(50), nullable=False, default="", server_default="")
    keywords_json = Column(JSON, nullable=False, default=list)
    interface_json = Column(JSON, nullable=False, default=dict)
    visibility = Column(String(20), nullable=False, default="workspace")
    allow_copy = Column(Boolean, nullable=False, default=False, server_default="0")
    status = Column(String(30), nullable=False, default="draft")
    latest_release_id = Column(big_integer_id_type(), nullable=True)
    featured_rank = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    updated_at = Column(
        DateTime, nullable=False, default=datetime.now, onupdate=datetime.now
    )
    published_at = Column(DateTime, nullable=True)

    __table_args__ = (
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
    )


class PluginRelease(Base):
    """Immutable package and metadata snapshot for a marketplace plugin."""

    __tablename__ = "plugin_releases"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    plugin_id = Column(
        big_integer_id_type(),
        ForeignKey("plugins.id", ondelete="CASCADE"),
        nullable=False,
    )
    version = Column(String(50), nullable=False)
    manifest_json = Column(JSON, nullable=False, default=dict)
    interface_json = Column(JSON, nullable=False, default=dict)
    release_notes = Column(Text, nullable=False, default="")
    storage_key = Column(String(500), nullable=False)
    sha256 = Column(String(64), nullable=False)
    size_bytes = Column(big_integer_id_type(), nullable=False)
    status = Column(String(20), nullable=False, default="processing")
    scan_status = Column(String(20), nullable=False, default="pending")
    scan_report_json = Column(JSON, nullable=False, default=dict)
    created_by_user_id = Column(big_integer_id_type(), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    published_at = Column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("plugin_id", "version", name="uniq_plugin_release_version"),
        Index("idx_plugin_releases_status", "plugin_id", "status", "published_at"),
        Index("idx_plugin_releases_sha256", "sha256"),
    )


class PluginUpstream(Base):
    """Selective upstream mirror configuration for one catalog plugin."""

    __tablename__ = "plugin_upstreams"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    plugin_id = Column(
        big_integer_id_type(),
        ForeignKey("plugins.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    provider = Column(String(50), nullable=False, default="codex")
    marketplace_name = Column(String(100), nullable=False)
    remote_plugin_id = Column(String(200), nullable=False)
    upstream_url = Column(String(500), nullable=False, default="", server_default="")
    license_info = Column(String(500), nullable=False, default="", server_default="")
    sync_enabled = Column(Boolean, nullable=False, default=True, server_default="1")
    sync_policy = Column(String(30), nullable=False, default="auto_after_scan")
    last_seen_version = Column(String(50), nullable=True)
    last_checked_at = Column(DateTime, nullable=True)
    last_synced_at = Column(DateTime, nullable=True)
    last_error = Column(String(1000), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "provider",
            "marketplace_name",
            "remote_plugin_id",
            name="uniq_plugin_upstream_source",
        ),
        Index("idx_plugin_upstreams_sync", "sync_enabled", "provider"),
    )


class PluginSubmission(Base):
    """Reviewable request to publish one immutable plugin release."""

    __tablename__ = "plugin_submissions"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    plugin_id = Column(
        big_integer_id_type(),
        ForeignKey("plugins.id", ondelete="CASCADE"),
        nullable=False,
    )
    release_id = Column(
        big_integer_id_type(),
        ForeignKey("plugin_releases.id", ondelete="CASCADE"),
        nullable=False,
    )
    submitter_user_id = Column(big_integer_id_type(), nullable=False)
    purpose = Column(
        String(30),
        nullable=False,
        default="marketplace_publish",
        server_default="marketplace_publish",
    )
    status = Column(String(20), nullable=False, default="uploading")
    reviewer_user_id = Column(big_integer_id_type(), nullable=True)
    review_note = Column(Text, nullable=False, default="")
    submitted_at = Column(DateTime, nullable=False, default=datetime.now)
    reviewed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("release_id", name="uniq_plugin_submission_release"),
        Index("idx_plugin_submissions_queue", "status", "submitted_at"),
        Index("idx_plugin_submissions_submitter", "submitter_user_id", "status"),
    )


class PluginDeviceInstallation(Base):
    """Materialized installation state for one account installation and device."""

    __tablename__ = "plugin_device_installations"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    installed_kind_id = Column(
        Integer,
        ForeignKey("kinds.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id = Column(big_integer_id_type(), nullable=False)
    device_id = Column(String(100), nullable=False)
    desired_release_id = Column(
        big_integer_id_type(),
        ForeignKey("plugin_releases.id", ondelete="RESTRICT"),
        nullable=False,
    )
    actual_release_id = Column(
        big_integer_id_type(),
        ForeignKey("plugin_releases.id", ondelete="SET NULL"),
        nullable=True,
    )
    state = Column(String(20), nullable=False, default="pending")
    error_code = Column(String(100), nullable=True)
    error_message = Column(String(1000), nullable=True)
    attempt_count = Column(Integer, nullable=False, default=0, server_default="0")
    last_sync_at = Column(DateTime, nullable=True)
    updated_at = Column(
        DateTime, nullable=False, default=datetime.now, onupdate=datetime.now
    )

    __table_args__ = (
        UniqueConstraint(
            "installed_kind_id",
            "device_id",
            name="uniq_plugin_device_installation",
        ),
        Index("idx_plugin_device_user_state", "user_id", "state"),
        Index("idx_plugin_device_device", "device_id", "updated_at"),
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
        "published_at",
    )
    changed = [
        field for field in immutable_fields if state.attrs[field].history.has_changes()
    ]
    if was_ready and changed:
        raise ValueError(
            f"Published plugin release fields are immutable: {', '.join(changed)}"
        )
