# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cloud synchronization records for Wework transcripts."""

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects import mysql
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.expression import ColumnElement

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")
EPOCH_TIME = datetime(1970, 1, 1)


def utcnow() -> datetime:
    """Return a naive UTC timestamp for SQLAlchemy DateTime columns."""

    return datetime.now(UTC).replace(tzinfo=None)


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


class WeworkTranscript(Base):
    """One device-independent Wework conversation."""

    __tablename__ = "wework_transcripts"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Wework transcript primary key",
    )
    user_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Owner user ID",
    )
    transcript_id = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Device-independent transcript identity",
    )
    parent_transcript_id = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Parent transcript identity; empty means this is a root transcript",
    )
    forked_at_sequence = Column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Parent sequence used to fork; 0 means no parent fork point",
    )
    title = Column(
        String(512),
        nullable=False,
        default="",
        server_default="",
        comment="Transcript display title",
    )
    state = Column(
        String(20),
        nullable=False,
        default="active",
        server_default="active",
        comment="Transcript lifecycle state: active or archived",
    )
    current_sequence = Column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Latest synchronized hot turn sequence",
    )
    archived_through_sequence = Column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Latest sequence moved to immutable archive storage",
    )
    writer_client_id = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Current writer device ID; empty means no active writer",
    )
    writer_fencing_token = Column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Monotonic token fencing stale device writes",
    )
    writer_lease_expires_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
        comment="Writer lease expiry time; epoch means no active lease",
    )
    archived_at = Column(
        _DATETIME,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00.000000",
        comment="Archive time; epoch means the transcript is not archived",
    )
    created_at = Column(
        _DATETIME,
        nullable=False,
        default=utcnow,
        server_default=_AuditTimestampDefault(),
        comment="Creation time",
    )
    updated_at = Column(
        _DATETIME,
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
        server_default=_AuditTimestampDefault(on_update=True),
        comment="Last update time",
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "transcript_id",
            name="uniq_wework_transcript_user_identity",
        ),
        Index("idx_wework_transcript_user_updated", "user_id", "updated_at"),
        Index(
            "idx_wework_transcript_parent",
            "user_id",
            "parent_transcript_id",
        ),
        {
            "comment": "Device-independent Wework transcript synchronization state",
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
        },
    )


class WeworkTranscriptTurn(Base):
    """One finalized hot transcript increment."""

    __tablename__ = "wework_transcript_turns"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Wework transcript turn primary key",
    )
    transcript_db_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Owning transcript ID; logical reference without database foreign key",
    )
    sequence = Column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Monotonic turn sequence within the transcript",
    )
    turn_id = Column(
        String(100),
        nullable=False,
        default="",
        server_default="",
        comment="Device-independent finalized turn identity",
    )
    payload = Column(
        JSON,
        nullable=False,
        comment="Finalized transcript turn payload",
    )
    created_at = Column(
        _DATETIME,
        nullable=False,
        default=utcnow,
        server_default=_AuditTimestampDefault(),
        comment="Creation time",
    )

    __table_args__ = (
        UniqueConstraint(
            "transcript_db_id",
            "sequence",
            name="uniq_wework_transcript_turn_sequence",
        ),
        UniqueConstraint(
            "transcript_db_id",
            "turn_id",
            name="uniq_wework_transcript_turn_identity",
        ),
        Index(
            "idx_wework_transcript_turn_range",
            "transcript_db_id",
            "sequence",
        ),
        {
            "comment": "Hot finalized turns awaiting transcript archival",
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
        },
    )


class WeworkTranscriptArchive(Base):
    """One immutable cold transcript segment in object storage."""

    __tablename__ = "wework_transcript_archives"

    id = Column(
        big_integer_id_type(),
        primary_key=True,
        autoincrement=True,
        comment="Wework transcript archive primary key",
    )
    transcript_db_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Owning transcript ID; logical reference without database foreign key",
    )
    from_sequence = Column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="First turn sequence contained in the archive",
    )
    to_sequence = Column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Last turn sequence contained in the archive",
    )
    storage_key = Column(
        String(500),
        nullable=False,
        default="",
        server_default="",
        comment="Immutable object-storage key for the compressed archive",
    )
    sha256 = Column(
        String(64),
        nullable=False,
        default="",
        server_default="",
        comment="SHA-256 digest of the compressed archive",
    )
    size_bytes = Column(
        BigInteger,
        nullable=False,
        default=0,
        server_default="0",
        comment="Compressed archive size in bytes",
    )
    format = Column(
        String(32),
        nullable=False,
        default="jsonl.zst",
        server_default="jsonl.zst",
        comment="Archive serialization and compression format",
    )
    created_at = Column(
        _DATETIME,
        nullable=False,
        default=utcnow,
        server_default=_AuditTimestampDefault(),
        comment="Creation time",
    )

    __table_args__ = (
        UniqueConstraint(
            "transcript_db_id",
            "from_sequence",
            "to_sequence",
            name="uniq_wework_transcript_archive_range",
        ),
        Index(
            "idx_wework_transcript_archive_range",
            "transcript_db_id",
            "from_sequence",
        ),
        {
            "comment": "Immutable archived Wework transcript segments",
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
        },
    )
