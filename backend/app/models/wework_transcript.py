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
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


def utcnow() -> datetime:
    """Return a naive UTC timestamp for SQLAlchemy DateTime columns."""

    return datetime.now(UTC).replace(tzinfo=None)


class WeworkTranscript(Base):
    """One device-independent Wework conversation."""

    __tablename__ = "wework_transcripts"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False, index=True)
    transcript_id = Column(String(100), nullable=False)
    title = Column(String(512), nullable=False, default="")
    state = Column(String(20), nullable=False, default="active")
    current_sequence = Column(BigInteger, nullable=False, default=0)
    archived_through_sequence = Column(BigInteger, nullable=False, default=0)
    writer_client_id = Column(String(100), nullable=True)
    writer_fencing_token = Column(BigInteger, nullable=False, default=0)
    writer_lease_expires_at = Column(DateTime, nullable=True)
    archived_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "transcript_id",
            name="uniq_wework_transcript_user_identity",
        ),
        Index("idx_wework_transcript_user_updated", "user_id", "updated_at"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class WeworkTranscriptTurn(Base):
    """One finalized hot transcript increment."""

    __tablename__ = "wework_transcript_turns"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    transcript_db_id = Column(
        big_integer_id_type(),
        ForeignKey("wework_transcripts.id", ondelete="CASCADE"),
        nullable=False,
    )
    sequence = Column(BigInteger, nullable=False)
    turn_id = Column(String(100), nullable=False)
    payload = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=utcnow)

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
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class WeworkTranscriptArchive(Base):
    """One immutable cold transcript segment in object storage."""

    __tablename__ = "wework_transcript_archives"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    transcript_db_id = Column(
        big_integer_id_type(),
        ForeignKey("wework_transcripts.id", ondelete="CASCADE"),
        nullable=False,
    )
    from_sequence = Column(BigInteger, nullable=False)
    to_sequence = Column(BigInteger, nullable=False)
    storage_key = Column(Text, nullable=False)
    sha256 = Column(String(64), nullable=False)
    size_bytes = Column(BigInteger, nullable=False)
    format = Column(String(32), nullable=False, default="jsonl.zst")
    created_at = Column(DateTime, nullable=False, default=utcnow)

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
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
