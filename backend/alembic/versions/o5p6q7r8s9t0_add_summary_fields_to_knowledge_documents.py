# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add summary fields to knowledge_documents

Revision ID: o5p6q7r8s9t0
Revises: l2m3n4o5p6q7
Create Date: 2025-12-30 10:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "o5p6q7r8s9t0"
down_revision: Union[str, None] = "l2m3n4o5p6q7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add summary-related columns to knowledge_documents table"""
    # Add summary column for storing document summary content
    op.add_column(
        "knowledge_documents", sa.Column("summary", sa.Text, nullable=True)
    )
    # Add summary_status enum column for tracking summary generation status
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "summary_status",
            sa.Enum("pending", "processing", "completed", "failed", name="summarystatus"),
            nullable=False,
            server_default="pending",
        ),
    )
    # Add summary_error column for storing error messages
    op.add_column(
        "knowledge_documents",
        sa.Column("summary_error", sa.String(500), nullable=True),
    )
    # Add summary_generated_at timestamp column
    op.add_column(
        "knowledge_documents",
        sa.Column("summary_generated_at", sa.DateTime, nullable=True),
    )


def downgrade() -> None:
    """Remove summary-related columns from knowledge_documents table"""
    op.drop_column("knowledge_documents", "summary_generated_at")
    op.drop_column("knowledge_documents", "summary_error")
    op.drop_column("knowledge_documents", "summary_status")
    op.drop_column("knowledge_documents", "summary")
    # Drop the enum type
    op.execute("DROP TYPE IF EXISTS summarystatus")
