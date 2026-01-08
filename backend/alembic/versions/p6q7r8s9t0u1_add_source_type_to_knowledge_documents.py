# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add source_type and source_config to knowledge_documents table

Revision ID: p6q7r8s9t0u1
Revises: o5p6q7r8s9t0
Create Date: 2025-01-06 10:00:00.000000

This migration adds:
1. source_type column to distinguish document sources (file, text, table)
2. source_config JSON column to store source configuration (e.g., {"url": "..."})
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "p6q7r8s9t0u1"
down_revision: Union[str, None] = "o5p6q7r8s9t0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add source_type and source_config columns to knowledge_documents table."""

    # Add source_type column with default value 'file' for existing records
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "source_type",
            sa.String(50),
            nullable=False,
            server_default="file",
        ),
    )

    # Add source_config JSON column for storing source configuration
    # Note: nullable=True to support backward compatibility with existing records
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "source_config",
            mysql.JSON(),
            nullable=True,
        ),
    )

    # Create index for source_type for efficient filtering
    op.create_index(
        "ix_knowledge_documents_source_type",
        "knowledge_documents",
        ["source_type"],
    )


def downgrade() -> None:
    """Remove source_type and source_config columns from knowledge_documents table."""

    # Drop index
    op.drop_index(
        "ix_knowledge_documents_source_type", table_name="knowledge_documents"
    )

    # Drop columns
    op.drop_column("knowledge_documents", "source_config")
    op.drop_column("knowledge_documents", "source_type")
