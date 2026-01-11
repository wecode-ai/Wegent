# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add summary column to knowledge_documents table

Revision ID: q7r8s9t0u1v2
Revises: p6q7r8s9t0u1
Create Date: 2025-01-12 10:00:00.000000

This migration adds:
1. summary JSON column to store document summary information
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "q7r8s9t0u1v2"
down_revision: Union[str, None] = "p6q7r8s9t0u1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add summary column to knowledge_documents table."""

    # Add summary JSON column for storing document summary information
    # Structure: {
    #   "short_summary": "...",
    #   "long_summary": "...",
    #   "topics": ["...", "..."],
    #   "meta_info": {"author": "...", "source": "...", "type": "..."},
    #   "status": "pending|generating|completed|failed",
    #   "error": "...",
    #   "updated_at": "..."
    # }
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "summary",
            mysql.JSON(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    """Remove summary column from knowledge_documents table."""

    op.drop_column("knowledge_documents", "summary")
