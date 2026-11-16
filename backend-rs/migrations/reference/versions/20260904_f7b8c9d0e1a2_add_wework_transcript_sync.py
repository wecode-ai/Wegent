"""Add Wework transcript hot and cold synchronization storage.

Revision ID: f7b8c9d0e1a2
Revises: e4a7b9c2d1f0
Create Date: 2026-09-04 00:00:00+08:00
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "f7b8c9d0e1a2"
down_revision: Union[str, Sequence[str], None] = "e4a7b9c2d1f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_EPOCH = "1970-01-01 00:00:00.000000"


def _datetime() -> sa.types.TypeEngine:
    return sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def _timestamp_default(*, on_update: bool = False) -> sa.TextClause:
    if op.get_bind().dialect.name == "sqlite":
        return sa.text("CURRENT_TIMESTAMP")
    value = "CURRENT_TIMESTAMP(6)"
    if on_update:
        value += " ON UPDATE CURRENT_TIMESTAMP(6)"
    return sa.text(value)


def upgrade() -> None:
    op.create_table(
        "wework_transcripts",
        sa.Column(
            "id",
            sa.BigInteger(),
            autoincrement=True,
            nullable=False,
            comment="Wework transcript primary key",
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Owner user ID",
        ),
        sa.Column(
            "transcript_id",
            sa.String(length=100),
            nullable=False,
            server_default="",
            comment="Device-independent transcript identity",
        ),
        sa.Column(
            "parent_transcript_id",
            sa.String(length=100),
            nullable=False,
            server_default="",
            comment="Parent transcript identity; empty means this is a root transcript",
        ),
        sa.Column(
            "forked_at_sequence",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="Parent sequence used to fork; 0 means no parent fork point",
        ),
        sa.Column(
            "title",
            sa.String(length=512),
            nullable=False,
            server_default="",
            comment="Transcript display title",
        ),
        sa.Column(
            "state",
            sa.String(length=20),
            nullable=False,
            server_default="active",
            comment="Transcript lifecycle state: active or archived",
        ),
        sa.Column(
            "current_sequence",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="Latest synchronized hot turn sequence",
        ),
        sa.Column(
            "archived_through_sequence",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="Latest sequence moved to immutable archive storage",
        ),
        sa.Column(
            "writer_client_id",
            sa.String(length=100),
            nullable=False,
            server_default="",
            comment="Current writer device ID; empty means no active writer",
        ),
        sa.Column(
            "writer_fencing_token",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="Monotonic token fencing stale device writes",
        ),
        sa.Column(
            "writer_lease_expires_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Writer lease expiry time; epoch means no active lease",
        ),
        sa.Column(
            "archived_at",
            _datetime(),
            nullable=False,
            server_default=_EPOCH,
            comment="Archive time; epoch means the transcript is not archived",
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
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "transcript_id",
            name="uniq_wework_transcript_user_identity",
        ),
        comment="Device-independent Wework transcript synchronization state",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_wework_transcript_user_updated",
        "wework_transcripts",
        ["user_id", "updated_at"],
    )
    op.create_index(
        "idx_wework_transcript_parent",
        "wework_transcripts",
        ["user_id", "parent_transcript_id"],
    )
    op.create_table(
        "wework_transcript_turns",
        sa.Column(
            "id",
            sa.BigInteger(),
            autoincrement=True,
            nullable=False,
            comment="Wework transcript turn primary key",
        ),
        sa.Column(
            "transcript_db_id",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment=(
                "Owning transcript ID; logical reference without database foreign key"
            ),
        ),
        sa.Column(
            "sequence",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="Monotonic turn sequence within the transcript",
        ),
        sa.Column(
            "turn_id",
            sa.String(length=100),
            nullable=False,
            server_default="",
            comment="Device-independent finalized turn identity",
        ),
        sa.Column(
            "payload",
            sa.JSON(),
            nullable=False,
            comment="Finalized transcript turn payload",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=_timestamp_default(),
            comment="Creation time",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "transcript_db_id",
            "sequence",
            name="uniq_wework_transcript_turn_sequence",
        ),
        sa.UniqueConstraint(
            "transcript_db_id",
            "turn_id",
            name="uniq_wework_transcript_turn_identity",
        ),
        comment="Hot finalized turns awaiting transcript archival",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_wework_transcript_turn_range",
        "wework_transcript_turns",
        ["transcript_db_id", "sequence"],
    )
    op.create_table(
        "wework_transcript_archives",
        sa.Column(
            "id",
            sa.BigInteger(),
            autoincrement=True,
            nullable=False,
            comment="Wework transcript archive primary key",
        ),
        sa.Column(
            "transcript_db_id",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment=(
                "Owning transcript ID; logical reference without database foreign key"
            ),
        ),
        sa.Column(
            "from_sequence",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="First turn sequence contained in the archive",
        ),
        sa.Column(
            "to_sequence",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="Last turn sequence contained in the archive",
        ),
        sa.Column(
            "storage_key",
            sa.String(length=500),
            nullable=False,
            server_default="",
            comment="Immutable object-storage key for the compressed archive",
        ),
        sa.Column(
            "sha256",
            sa.String(length=64),
            nullable=False,
            server_default="",
            comment="SHA-256 digest of the compressed archive",
        ),
        sa.Column(
            "size_bytes",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
            comment="Compressed archive size in bytes",
        ),
        sa.Column(
            "format",
            sa.String(length=32),
            nullable=False,
            server_default="jsonl.zst",
            comment="Archive serialization and compression format",
        ),
        sa.Column(
            "created_at",
            _datetime(),
            nullable=False,
            server_default=_timestamp_default(),
            comment="Creation time",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "transcript_db_id",
            "from_sequence",
            "to_sequence",
            name="uniq_wework_transcript_archive_range",
        ),
        comment="Immutable archived Wework transcript segments",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_wework_transcript_archive_range",
        "wework_transcript_archives",
        ["transcript_db_id", "from_sequence"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_wework_transcript_archive_range",
        table_name="wework_transcript_archives",
    )
    op.drop_table("wework_transcript_archives")
    op.drop_index(
        "idx_wework_transcript_turn_range",
        table_name="wework_transcript_turns",
    )
    op.drop_table("wework_transcript_turns")
    op.drop_index(
        "idx_wework_transcript_parent",
        table_name="wework_transcripts",
    )
    op.drop_index(
        "idx_wework_transcript_user_updated",
        table_name="wework_transcripts",
    )
    op.drop_table("wework_transcripts")
