"""Add Wework transcript hot and cold synchronization storage.

Revision ID: f7b8c9d0e1a2
Revises: e4a7b9c2d1f0
Create Date: 2026-09-04 00:00:00+08:00
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f7b8c9d0e1a2"
down_revision: Union[str, Sequence[str], None] = "e4a7b9c2d1f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "wework_transcripts",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("transcript_id", sa.String(length=100), nullable=False),
        sa.Column("title", sa.String(length=512), nullable=False),
        sa.Column("state", sa.String(length=20), nullable=False),
        sa.Column("current_sequence", sa.BigInteger(), nullable=False),
        sa.Column("archived_through_sequence", sa.BigInteger(), nullable=False),
        sa.Column("writer_client_id", sa.String(length=100), nullable=True),
        sa.Column("writer_fencing_token", sa.BigInteger(), nullable=False),
        sa.Column("writer_lease_expires_at", sa.DateTime(), nullable=True),
        sa.Column("archived_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "transcript_id",
            name="uniq_wework_transcript_user_identity",
        ),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "ix_wework_transcripts_user_id",
        "wework_transcripts",
        ["user_id"],
    )
    op.create_index(
        "idx_wework_transcript_user_updated",
        "wework_transcripts",
        ["user_id", "updated_at"],
    )
    op.create_table(
        "wework_transcript_turns",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("transcript_db_id", sa.BigInteger(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("turn_id", sa.String(length=100), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["transcript_db_id"],
            ["wework_transcripts.id"],
            ondelete="CASCADE",
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
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_wework_transcript_turn_range",
        "wework_transcript_turns",
        ["transcript_db_id", "sequence"],
    )
    op.create_table(
        "wework_transcript_archives",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("transcript_db_id", sa.BigInteger(), nullable=False),
        sa.Column("from_sequence", sa.BigInteger(), nullable=False),
        sa.Column("to_sequence", sa.BigInteger(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("format", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["transcript_db_id"],
            ["wework_transcripts.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "transcript_db_id",
            "from_sequence",
            "to_sequence",
            name="uniq_wework_transcript_archive_range",
        ),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
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
        "idx_wework_transcript_user_updated",
        table_name="wework_transcripts",
    )
    op.drop_index(
        "ix_wework_transcripts_user_id",
        table_name="wework_transcripts",
    )
    op.drop_table("wework_transcripts")
