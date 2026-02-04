# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add index_status column to knowledge_documents

Revision ID: x4y5z6a7b8c9
Revises: w3x4y5z6a7b8
Create Date: 2025-02-04

This migration adds an index_status column to track document indexing progress.

The index_status column values:
- '' (empty string): Legacy default, status determined by is_active field
- 'indexing': Document is currently being indexed
- 'completed': Indexing completed successfully
- 'failed': Indexing failed
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "x4y5z6a7b8c9"
down_revision: Union[str, None] = "w3x4y5z6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def column_exists(table_name: str, column_name: str) -> bool:
    """Check if a column exists in a table."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.columns "
            "WHERE table_name = :table_name AND column_name = :column_name"
        ),
        {"table_name": table_name, "column_name": column_name},
    )
    return result.scalar() > 0


def upgrade() -> None:
    """Add index_status column to knowledge_documents table."""

    # Check if column already exists (handles case where DB was modified manually)
    if column_exists("knowledge_documents", "index_status"):
        return

    # Add index_status column for tracking indexing progress
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "index_status",
            sa.String(20),
            nullable=False,
            server_default="",
            comment="Index status: '' (legacy), 'indexing', 'completed', 'failed'",
        ),
    )


def downgrade() -> None:
    """Remove index_status column from knowledge_documents table."""

    op.drop_column("knowledge_documents", "index_status")
