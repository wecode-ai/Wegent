# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add duckdb_cache table

Revision ID: e5f6a7b8c901
Revises: c3d4e5f6a708
Create Date: 2026-05-12

Adds duckdb_cache table for tracking DuckDB generation status
and metadata for Excel/CSV attachments.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "e5f6a7b8c901"
down_revision = "c3d4e5f6a708"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "duckdb_cache",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("attachment_id", sa.Integer(), nullable=False),
        sa.Column("duckdb_attachment_id", sa.Integer(), nullable=True),
        sa.Column("summary", sa.JSON(), nullable=True),
        sa.Column(
            "tables_count", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "file_size", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("source_file_hash", sa.String(64), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "ix_duckdb_cache_attachment_id",
        "duckdb_cache",
        ["attachment_id"],
        unique=True,
    )
    op.create_index(
        "ix_duckdb_cache_status",
        "duckdb_cache",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_duckdb_cache_status", table_name="duckdb_cache")
    op.drop_index("ix_duckdb_cache_attachment_id", table_name="duckdb_cache")
    op.drop_table("duckdb_cache")
