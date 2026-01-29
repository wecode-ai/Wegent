# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add chunks column to knowledge_documents

Revision ID: w3x4y5z6a7b8
Revises: v2w3x4y5z6a7
Create Date: 2025-01-23

This migration adds a chunks JSON column to store document chunk metadata
including content, token count, and position information.

The chunks column stores:
{
    "items": [
        {
            "index": 0,
            "content": "chunk text content",
            "token_count": 150,
            "start_position": 0,
            "end_position": 500
        }
    ],
    "total_count": 25,
    "splitter_type": "smart",
    "splitter_subtype": "markdown_sentence|sentence|recursive_character",
    "created_at": "2025-01-23T12:00:00Z"
}
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "w3x4y5z6a7b8"
down_revision: Union[str, None] = "v2w3x4y5z6a7"
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
    """Add chunks column to knowledge_documents table."""

    # Check if column already exists (handles case where DB was modified manually)
    if column_exists("knowledge_documents", "chunks"):
        return

    # Add chunks JSON column for storing document chunk metadata
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "chunks",
            sa.JSON(),
            nullable=True,
            comment="Document chunk metadata including content and position info",
        ),
    )


def downgrade() -> None:
    """Remove chunks column from knowledge_documents table."""

    op.drop_column("knowledge_documents", "chunks")
