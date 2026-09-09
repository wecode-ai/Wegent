"""Store native Wework transcript segments in encrypted object storage.

Revision ID: a1c2d3e4f5b6
Revises: 580031eb7ddc
Create Date: 2026-09-08 00:00:00+08:00
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a1c2d3e4f5b6"
down_revision: str | Sequence[str] | None = "580031eb7ddc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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
