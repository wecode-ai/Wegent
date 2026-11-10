# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add server-owned answer attempts and evidence snapshots.

Revision ID: a91e7c42d803
Revises: f3a7c9e1b2d4
"""

import sqlalchemy as sa
from alembic import op

revision = "a91e7c42d803"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subtasks", sa.Column("answer_generation_id", sa.String(32), nullable=True)
    )
    op.create_table(
        "knowledge_citations",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("knowledge_base_id", sa.Integer(), nullable=False),
        sa.Column("document_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(1024), nullable=False),
        sa.Column("content", sa.String(5000), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("caller_context", sa.JSON(), nullable=False),
        sa.Column("source_chunk_id", sa.String(255), nullable=False, server_default=""),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )


def downgrade() -> None:
    # Snapshots and attempt identities are intentionally discarded on rollback.
    op.drop_table("knowledge_citations")
    op.drop_column("subtasks", "answer_generation_id")
