# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add knowledge document index state

Revision ID: b1c2d3e4f607
Revises: b1c2d3e4f5g6
Create Date: 2026-03-26

Add business-level indexing state fields to knowledge_documents so duplicate
Celery redelivery/retry tasks can be rejected safely.
"""

import sqlalchemy as sa

from alembic import op

revision = "b1c2d3e4f607"
down_revision = "b1c2d3e4f5g6"
branch_labels = None
depends_on = None

INDEX_STATUS_TYPE = sa.String(length=32)


def upgrade() -> None:
    """Add knowledge document indexing state columns and backfill them."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {
        column["name"] for column in inspector.get_columns("knowledge_documents")
    }

    if "index_status" not in existing_columns:
        op.add_column(
            "knowledge_documents",
            sa.Column(
                "index_status",
                INDEX_STATUS_TYPE,
                nullable=False,
                server_default="not_indexed",
            ),
        )
    else:
        op.alter_column(
            "knowledge_documents",
            "index_status",
            existing_type=sa.String(length=32),
            type_=INDEX_STATUS_TYPE,
            existing_nullable=False,
            server_default="not_indexed",
        )
    if "index_generation" not in existing_columns:
        op.add_column(
            "knowledge_documents",
            sa.Column(
                "index_generation",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )

    op.execute(
        sa.text(
            """
            UPDATE knowledge_documents
            SET
                index_status = CASE
                    WHEN is_active = 1 THEN 'success'
                    WHEN COALESCE(index_generation, 0) = 0 THEN 'not_indexed'
                    ELSE index_status
                END,
                index_generation = CASE
                    WHEN is_active = 1 AND COALESCE(index_generation, 0) = 0 THEN 1
                    ELSE COALESCE(index_generation, 0)
                END
            """
        )
    )


def downgrade() -> None:
    """Remove knowledge document indexing state columns."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {
        column["name"] for column in inspector.get_columns("knowledge_documents")
    }

    for column_name in ["index_generation", "index_status"]:
        if column_name in existing_columns:
            op.drop_column("knowledge_documents", column_name)
