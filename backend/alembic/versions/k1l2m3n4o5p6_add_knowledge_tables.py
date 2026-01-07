# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add knowledge_documents table

Revision ID: k1l2m3n4o5p6
Revises: i9j0k1l2m3n4
Create Date: 2025-12-16 10:00:00.000000+08:00

This migration creates:
1. knowledge_documents table for storing document references
   - kind_id references kinds.id (Kind='KnowledgeBase') - no FK constraint, managed at application layer
   - attachment_id references subtask_attachments.id - no FK constraint, managed at application layer
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "k1l2m3n4o5p6"
down_revision: Union[str, None] = "i9j0k1l2m3n4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create knowledge_documents table."""

    # Create knowledge_documents table
    # Note: No foreign key constraints - referential integrity is managed at the application layer
    op.create_table(
        "knowledge_documents",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        # References kinds.id (Kind='KnowledgeBase') - no FK constraint
        sa.Column("kind_id", sa.Integer(), nullable=False),
        # References subtask_attachments.id - no FK constraint
        sa.Column("attachment_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("file_extension", sa.String(50), nullable=False),
        sa.Column("file_size", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "status",
            sa.Enum("enabled", "disabled", name="documentstatus"),
            nullable=False,
            server_default="enabled",
        ),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Create indexes for knowledge_documents
    op.create_index(
        "ix_knowledge_documents_kind_active_created",
        "knowledge_documents",
        ["kind_id", "is_active", "created_at"],
    )
    op.create_index(
        "ix_knowledge_documents_attachment",
        "knowledge_documents",
        ["attachment_id"],
    )
    op.create_index(
        "ix_knowledge_documents_user_id",
        "knowledge_documents",
        ["user_id"],
    )


def downgrade() -> None:
    """Drop knowledge_documents table."""

    # Drop knowledge_documents table
    op.drop_index("ix_knowledge_documents_user_id", table_name="knowledge_documents")
    op.drop_index("ix_knowledge_documents_attachment", table_name="knowledge_documents")
    op.drop_index(
        "ix_knowledge_documents_kind_active_created", table_name="knowledge_documents"
    )
    op.drop_table("knowledge_documents")

    # Drop enum type
    op.execute("DROP TYPE IF EXISTS documentstatus")
