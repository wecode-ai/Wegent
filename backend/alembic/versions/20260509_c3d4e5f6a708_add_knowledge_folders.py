# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add knowledge_folders table and folder_id to knowledge_documents

Revision ID: c3d4e5f6a708
Revises: b2c3d4e5f707
Create Date: 2026-05-09

Add knowledge_folders table for multi-level folder hierarchy within
knowledge bases. Add folder_id column to knowledge_documents to
associate documents with folders (0 = root level).
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "c3d4e5f6a708"
down_revision = "b2c3d4e5f707"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "knowledge_folders",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind_id", sa.Integer(), nullable=False),
        sa.Column(
            "parent_id", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
        comment="Knowledge base folder hierarchy for multi-level document organization",
    )
    op.create_index(
        "ix_knowledge_folders_parent",
        "knowledge_folders",
        ["kind_id", "parent_id"],
        unique=False,
    )

    # Add folder_id column to knowledge_documents (0 = root level, NOT NULL)
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "folder_id",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.create_index(
        "ix_knowledge_documents_folder",
        "knowledge_documents",
        ["folder_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_documents_folder", table_name="knowledge_documents")
    op.drop_column("knowledge_documents", "folder_id")
    op.drop_index("ix_knowledge_folders_parent", table_name="knowledge_folders")
    op.drop_table("knowledge_folders")
