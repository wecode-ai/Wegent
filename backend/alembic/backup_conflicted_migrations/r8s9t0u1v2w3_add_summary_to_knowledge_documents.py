# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add summary field to knowledge_documents table

Revision ID: r8s9t0u1v2w3
Revises: p6q7r8s9t0u1
Create Date: 2025-01-12 10:00:00.000000

This migration adds:
1. summary JSON column to store document summary information including
   short_summary, long_summary, topics, meta_info, status, error, task_id, updated_at
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "r8s9t0u1v2w3"
down_revision: Union[str, None] = "p6q7r8s9t0u1"
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
    """Add summary column to knowledge_documents table."""

    # Check if column already exists (handles case where DB was modified manually)
    if column_exists("knowledge_documents", "summary"):
        return

    # Add summary JSON column for storing document summary information
    # Structure: {
    #   "short_summary": "Short summary (50-100 chars)",
    #   "long_summary": "Long summary (up to 500 chars)",
    #   "topics": ["topic1", "topic2"],
    #   "meta_info": {"author": "...", "source": "...", "type": "..."},
    #   "status": "pending|generating|completed|failed",
    #   "error": "Error message if failed",
    #   "task_id": 12345,
    #   "updated_at": "2025-01-12T10:00:00Z"
    # }
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "summary",
            sa.JSON(),
            nullable=True,
            comment="Document summary information (JSON)",
        ),
    )


def downgrade() -> None:
    """Remove summary column from knowledge_documents table."""

    op.drop_column("knowledge_documents", "summary")
