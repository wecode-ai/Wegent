# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Enterprise plugin publication workflow models."""

from datetime import datetime, timezone

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
from app.models.plugin_marketplace import EPOCH_TIME
from shared.models.db.types import big_integer_id_type

_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class PluginPublicationRequest(Base):
    """One enterprise-publication request with an append-only revision history."""

    __tablename__ = "plugin_publication_requests"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    source_plugin_id = Column(big_integer_id_type(), nullable=False, default=0)
    target_plugin_id = Column(big_integer_id_type(), nullable=False, default=0)
    submitter_user_id = Column(big_integer_id_type(), nullable=False, default=0)
    current_revision_id = Column(big_integer_id_type(), nullable=False, default=0)
    current_revision = Column(Integer, nullable=False, default=1)
    aggregate_status = Column(
        String(40), nullable=False, default="uploading", server_default="uploading"
    )
    risk_level = Column(
        String(20), nullable=False, default="none", server_default="none"
    )
    submitted_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
    )
    created_at = Column(_DATETIME, nullable=False, default=_utc_now)
    updated_at = Column(_DATETIME, nullable=False, default=_utc_now, onupdate=_utc_now)

    __table_args__ = (
        Index(
            "idx_plugin_publication_request_owner",
            "submitter_user_id",
            "aggregate_status",
            "updated_at",
        ),
        Index(
            "idx_plugin_publication_request_source",
            "source_plugin_id",
            "aggregate_status",
        ),
        {
            "comment": "Enterprise plugin publication request aggregates",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginPublicationRevision(Base):
    """Immutable submitted snapshot plus mutable workflow projections."""

    __tablename__ = "plugin_publication_revisions"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    request_id = Column(big_integer_id_type(), nullable=False, default=0)
    revision = Column(Integer, nullable=False, default=1)
    source_release_id = Column(big_integer_id_type(), nullable=False, default=0)
    requested_version = Column(String(50), nullable=False, default="")
    snapshot_sha256 = Column(String(64), nullable=False, default="")
    source_tree_sha256 = Column(String(64), nullable=False, default="")
    storage_key = Column(String(500), nullable=False, default="")
    staging_storage_key = Column(String(500), nullable=False, default="")
    filename = Column(String(255), nullable=False, default="plugin.zip")
    size_bytes = Column(big_integer_id_type(), nullable=False, default=0)
    manifest_snapshot = Column(JSON, nullable=False, default=dict)
    package_entries_json = Column(JSON, nullable=False, default=list)
    package_entry_count = Column(Integer, nullable=False, default=0)
    capabilities_json = Column(JSON, nullable=False, default=list)
    risk_declaration = Column(JSON, nullable=False, default=dict)
    release_notes = Column(String(4096), nullable=False, default="")
    test_notes = Column(String(4096), nullable=False, default="")
    source_updated_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
    )
    status = Column(
        String(40), nullable=False, default="uploading", server_default="uploading"
    )
    gitlab_project_id = Column(String(100), nullable=False, default="")
    gitlab_project_url = Column(String(500), nullable=False, default="")
    source_branch = Column(String(255), nullable=False, default="")
    merge_request_iid = Column(Integer, nullable=False, default=0)
    merge_request_url = Column(String(500), nullable=False, default="")
    merge_request_status = Column(String(40), nullable=False, default="")
    pipeline_id = Column(big_integer_id_type(), nullable=False, default=0)
    pipeline_url = Column(String(500), nullable=False, default="")
    pipeline_status = Column(String(40), nullable=False, default="")
    commit_sha = Column(String(64), nullable=False, default="")
    created_by_user_id = Column(big_integer_id_type(), nullable=False, default=0)
    completed_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
    )
    created_at = Column(_DATETIME, nullable=False, default=_utc_now)
    updated_at = Column(_DATETIME, nullable=False, default=_utc_now, onupdate=_utc_now)

    __table_args__ = (
        UniqueConstraint(
            "request_id", "revision", name="uniq_plugin_publication_revision"
        ),
        Index("idx_plugin_publication_revision_status", "status", "updated_at"),
        Index(
            "idx_plugin_publication_revision_gitlab",
            "gitlab_project_id",
            "merge_request_iid",
        ),
        {
            "comment": "Immutable enterprise publication snapshots",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginPublicationCheck(Base):
    """Stable automated or CI check attached to one revision."""

    __tablename__ = "plugin_publication_checks"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    revision_id = Column(big_integer_id_type(), nullable=False, default=0)
    stage = Column(String(40), nullable=False, default="automatic")
    check_code = Column(String(100), nullable=False, default="")
    title = Column(String(200), nullable=False, default="")
    severity = Column(String(20), nullable=False, default="info")
    status = Column(String(20), nullable=False, default="pending")
    summary = Column(String(1000), nullable=False, default="")
    evidence_json = Column(JSON, nullable=False, default=list)
    execution_environment = Column(String(100), nullable=False, default="backend")
    job_url = Column(String(500), nullable=False, default="")
    acknowledgement_required = Column(Boolean, nullable=False, default=False)
    acknowledged = Column(Boolean, nullable=False, default=False)
    acknowledged_by_user_id = Column(big_integer_id_type(), nullable=False, default=0)
    created_at = Column(_DATETIME, nullable=False, default=_utc_now)
    updated_at = Column(_DATETIME, nullable=False, default=_utc_now, onupdate=_utc_now)

    __table_args__ = (
        UniqueConstraint(
            "revision_id", "check_code", name="uniq_plugin_publication_check"
        ),
        Index("idx_plugin_publication_check_status", "revision_id", "status"),
        {
            "comment": "Publication check evidence by stable code",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginPublicationEvent(Base):
    """Append-only publication audit event."""

    __tablename__ = "plugin_publication_events"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    revision_id = Column(big_integer_id_type(), nullable=False, default=0)
    event_type = Column(String(100), nullable=False, default="")
    actor_type = Column(String(30), nullable=False, default="system")
    actor_id = Column(big_integer_id_type(), nullable=False, default=0)
    actor_name = Column(String(200), nullable=False, default="")
    message = Column(String(1000), nullable=False, default="")
    payload_json = Column(JSON, nullable=False, default=dict)
    external_event_id = Column(String(200), nullable=False, default="")
    created_at = Column(_DATETIME, nullable=False, default=_utc_now)

    __table_args__ = (
        UniqueConstraint(
            "external_event_id", name="uniq_plugin_publication_external_event"
        ),
        Index("idx_plugin_publication_event_timeline", "revision_id", "created_at"),
        {
            "comment": "Append-only publication workflow audit events",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginPublicationIdempotency(Base):
    """Durable idempotency binding for publication workflow mutations."""

    __tablename__ = "plugin_publication_idempotency"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    principal_type = Column(String(20), nullable=False, default="user")
    principal_id = Column(big_integer_id_type(), nullable=False, default=0)
    operation = Column(String(80), nullable=False, default="")
    idempotency_key = Column(String(200), nullable=False, default="")
    resource_key = Column(String(255), nullable=False, default="")
    request_sha256 = Column(String(64), nullable=False, default="")
    status = Column(
        String(20), nullable=False, default="processing", server_default="processing"
    )
    response_json = Column(JSON, nullable=False, default=dict)
    created_at = Column(_DATETIME, nullable=False, default=_utc_now)
    updated_at = Column(_DATETIME, nullable=False, default=_utc_now, onupdate=_utc_now)

    __table_args__ = (
        UniqueConstraint(
            "principal_type",
            "principal_id",
            "operation",
            "idempotency_key",
            name="uniq_plugin_publication_idempotency",
        ),
        Index("idx_plugin_publication_idempotency_status", "status", "updated_at"),
        {
            "comment": "Durable publication workflow idempotency bindings",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


class PluginReleaseIdempotency(Base):
    """Durable binding between one release key and its complete request."""

    __tablename__ = "plugin_release_idempotency"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    idempotency_key = Column(String(81), nullable=False, default="")
    request_sha256 = Column(String(64), nullable=False, default="")
    artifact_sha256 = Column(String(64), nullable=False, default="")
    envelope_json = Column(JSON, nullable=False, default=dict)
    status = Column(
        String(20), nullable=False, default="processing", server_default="processing"
    )
    response_json = Column(JSON, nullable=False, default=dict)
    plugin_id = Column(big_integer_id_type(), nullable=False, default=0)
    release_id = Column(big_integer_id_type(), nullable=False, default=0)
    last_error = Column(String(1000), nullable=False, default="")
    created_at = Column(_DATETIME, nullable=False, default=_utc_now)
    updated_at = Column(_DATETIME, nullable=False, default=_utc_now, onupdate=_utc_now)

    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uniq_plugin_release_idempotency_key"),
        Index("idx_plugin_release_idempotency_status", "status", "updated_at"),
        {
            "comment": "Durable protected-pipeline release idempotency bindings",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )


@event.listens_for(PluginPublicationRevision, "before_update")
def prevent_submitted_revision_mutation(mapper, connection, target) -> None:
    """Prevent snapshot fields from changing after upload completion."""
    del mapper, connection
    state = inspect(target)
    status_history = state.attrs.status.history
    previous_statuses = status_history.deleted
    previous_status = previous_statuses[0] if previous_statuses else target.status
    if previous_status == "uploading":
        return
    immutable_fields = (
        "request_id",
        "revision",
        "source_release_id",
        "requested_version",
        "snapshot_sha256",
        "source_tree_sha256",
        "storage_key",
        "filename",
        "size_bytes",
        "manifest_snapshot",
        "package_entries_json",
        "package_entry_count",
        "capabilities_json",
        "risk_declaration",
        "release_notes",
        "test_notes",
        "source_updated_at",
        "created_by_user_id",
        "created_at",
    )
    changed = [
        field for field in immutable_fields if state.attrs[field].history.has_changes()
    ]
    if changed:
        raise ValueError(
            "Submitted publication revision fields are immutable: " + ", ".join(changed)
        )
