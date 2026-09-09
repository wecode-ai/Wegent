"""Store native Wework transcript segments only in object storage.

Revision ID: a1c2d3e4f5b6
Revises: f7b8c9d0e1a2
Create Date: 2026-09-08 00:00:00+08:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "a1c2d3e4f5b6"
down_revision: str | Sequence[str] | None = "580031eb7ddc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index(
        "idx_wework_transcript_turn_range",
        table_name="wework_transcript_turns",
    )
    op.drop_table("wework_transcript_turns")
    with op.batch_alter_table("wework_transcript_archives") as batch:
        batch.drop_constraint(
            "uniq_wework_transcript_archive_range",
            type_="unique",
        )
        batch.create_unique_constraint(
            "uniq_wework_transcript_archive_sequence",
            ["transcript_db_id", "to_sequence"],
        )
        batch.alter_column(
            "format",
            existing_type=sa.String(length=32),
            existing_nullable=False,
            existing_server_default="jsonl.zst",
            type_=sa.String(length=64),
            server_default="codex-rollout-delta.v1.tgz.aes256gcm",
            comment="Native segment kind, serialization, and compression format",
        )


def downgrade() -> None:
    with op.batch_alter_table("wework_transcript_archives") as batch:
        batch.drop_constraint(
            "uniq_wework_transcript_archive_sequence",
            type_="unique",
        )
        batch.create_unique_constraint(
            "uniq_wework_transcript_archive_range",
            ["transcript_db_id", "from_sequence", "to_sequence"],
        )
        batch.alter_column(
            "format",
            existing_type=sa.String(length=64),
            existing_nullable=False,
            existing_server_default="codex-rollout-delta.v1.tgz.aes256gcm",
            type_=sa.String(length=32),
            server_default="jsonl.zst",
            comment="Archive serialization and compression format",
        )
    datetime_type = sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")
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
            datetime_type,
            nullable=False,
            server_default=(
                sa.text("CURRENT_TIMESTAMP")
                if op.get_bind().dialect.name == "sqlite"
                else sa.text("CURRENT_TIMESTAMP(6)")
            ),
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
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
        comment="Hot finalized turns awaiting transcript archival",
    )
    op.create_index(
        "idx_wework_transcript_turn_range",
        "wework_transcript_turns",
        ["transcript_db_id", "sequence"],
    )
