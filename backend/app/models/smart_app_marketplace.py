# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Relational models for Smart app publication and restricted distribution."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects import mysql
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.expression import ColumnElement

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")
EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


class _AuditTimestampDefault(ColumnElement):
    """Render audited MySQL timestamp defaults without breaking SQLite tests."""

    inherit_cache = True
    type = DateTime()

    def __init__(self, *, on_update: bool = False) -> None:
        self.on_update = on_update


@compiles(_AuditTimestampDefault)
def _compile_timestamp_default(
    element: _AuditTimestampDefault, compiler, **kwargs
) -> str:
    return "CURRENT_TIMESTAMP"


@compiles(_AuditTimestampDefault, "mysql")
def _compile_mysql_timestamp_default(
    element: _AuditTimestampDefault, compiler, **kwargs
) -> str:
    value = "CURRENT_TIMESTAMP(6)"
    if element.on_update:
        value += " ON UPDATE CURRENT_TIMESTAMP(6)"
    return value


def _json_default(value: str):
    return text(f"('{value}')")


class SmartApp(Base):
    """Stable cloud catalog identity for a locally executed Smart app."""

    __tablename__ = "smart_apps"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Smart app primary key",
    )
    owner_user_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Owner user ID; 0 means platform-owned official app",
    )
    name = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Canonical Smart app name from manifest",
    )
    display_name = Column(
        String(200),
        nullable=False,
        default="",
        server_default="",
        comment="Human-readable Smart app title",
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
        comment="Markdown marketplace description, limited to 8192 characters",
    )
    source_type = Column(
        String(20),
        nullable=False,
        default="user",
        server_default="user",
        comment="Publisher source: official or user",
    )
    visibility = Column(
        String(20),
        nullable=False,
        default="restricted",
        server_default="restricted",
        comment="Distribution scope: public, restricted, or private",
    )
    status = Column(
        String(20),
        nullable=False,
        default="draft",
        server_default="draft",
        comment="Catalog lifecycle status: draft or published",
    )
    tags_json = Column(
        JSON,
        nullable=False,
        default=list,
        server_default=_json_default("[]"),
        comment="Marketplace tag IDs as a JSON array",
    )
    icon_storage_key = Column(
        String(500),
        nullable=False,
        default="",
        server_default="",
        comment="Object-storage key for the active icon",
    )
    screenshots_json = Column(
        JSON,
        nullable=False,
        default=list,
        server_default=_json_default("[]"),
        comment="Object-storage keys for screenshots as a JSON array",
    )
    extensions_json = Column(
        JSON,
        nullable=False,
        default=dict,
        server_default=_json_default("{}"),
        comment="Versioned namespaced application extension fields",
    )
    latest_release_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Latest published release ID; 0 means no release",
    )
    featured_rank = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Marketplace featured rank; 0 means not featured",
    )
    created_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        server_default=_AuditTimestampDefault(),
        comment="Creation time",
    )
    updated_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
        server_default=_AuditTimestampDefault(on_update=True),
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
        UniqueConstraint("owner_user_id", "name", name="uniq_smart_app_owner_name"),
        Index("idx_smart_apps_catalog", "status", "source_type", "featured_rank"),
        {
            "comment": "Smart app marketplace catalog identities",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class SmartAppRelease(Base):
    """Immutable executable package for one Smart app version."""

    __tablename__ = "smart_app_releases"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Smart app release primary key",
    )
    smart_app_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Owning Smart app ID; logical reference without database foreign key",
    )
    version = Column(
        String(50),
        nullable=False,
        default="",
        server_default="",
        comment="Immutable semantic version",
    )
    manifest_json = Column(
        JSON,
        nullable=False,
        default=dict,
        server_default=_json_default("{}"),
        comment="Validated immutable runtime manifest snapshot",
    )
    release_notes = Column(
        String(4096),
        nullable=False,
        default="",
        server_default="",
        comment="Release notes, limited to 4096 characters",
    )
    storage_key = Column(
        String(500),
        nullable=False,
        default="",
        server_default="",
        comment="Immutable package object-storage key",
    )
    sha256 = Column(
        String(64),
        nullable=False,
        default="",
        server_default="",
        comment="Lowercase package SHA-256 hex digest",
    )
    size_bytes = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Package size in bytes",
    )
    scan_status = Column(
        String(20),
        nullable=False,
        default="passed",
        server_default="passed",
        comment="Security scan status: passed or failed",
    )
    scan_report_json = Column(
        JSON,
        nullable=False,
        default=dict,
        server_default=_json_default("{}"),
        comment="Security scan report snapshot",
    )
    extensions_json = Column(
        JSON,
        nullable=False,
        default=dict,
        server_default=_json_default("{}"),
        comment="Versioned namespaced release extension fields",
    )
    created_by_user_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Publisher user ID; 0 means official publisher",
    )
    created_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        server_default=_AuditTimestampDefault(),
        comment="Creation time",
    )
    published_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        server_default=_AuditTimestampDefault(),
        comment="Release publish time",
    )

    __table_args__ = (
        UniqueConstraint(
            "smart_app_id", "version", name="uniq_smart_app_release_version"
        ),
        Index("idx_smart_app_releases_app", "smart_app_id", "published_at"),
        {
            "comment": "Immutable Smart app package releases",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class SmartAppSubmission(Base):
    """Two-phase user upload tracked until validation and publication complete."""

    __tablename__ = "smart_app_submissions"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Smart app submission primary key",
    )
    smart_app_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Target Smart app ID; logical reference without database foreign key",
    )
    owner_user_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Submitting owner user ID",
    )
    version = Column(
        String(50),
        nullable=False,
        default="",
        server_default="",
        comment="Submitted semantic version",
    )
    status = Column(
        String(20),
        nullable=False,
        default="uploading",
        server_default="uploading",
        comment="Submission status: uploading, scanning, published, rejected, or cancelled",
    )
    staging_storage_key = Column(
        String(500),
        nullable=False,
        default="",
        server_default="",
        comment="Temporary package object-storage key",
    )
    sha256 = Column(
        String(64),
        nullable=False,
        default="",
        server_default="",
        comment="Expected lowercase package SHA-256 hex digest",
    )
    size_bytes = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Expected package size in bytes",
    )
    metadata_json = Column(
        JSON,
        nullable=False,
        default=dict,
        server_default=_json_default("{}"),
        comment="Submission listing, asset, recipient, and extension snapshot",
    )
    error_message = Column(
        String(1000),
        nullable=False,
        default="",
        server_default="",
        comment="Rejected submission error; empty means no error",
    )
    created_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        server_default=_AuditTimestampDefault(),
        comment="Creation time",
    )
    updated_at = Column(
        _DATETIME,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
        server_default=_AuditTimestampDefault(on_update=True),
        comment="Last update time",
    )

    __table_args__ = (
        Index("idx_smart_app_submissions_owner", "owner_user_id", "status"),
        {
            "comment": "Two-phase Smart app publication submissions",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )
