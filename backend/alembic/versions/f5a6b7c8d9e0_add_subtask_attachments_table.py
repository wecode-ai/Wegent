# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add subtask_attachments table for file upload support

Revision ID: f5a6b7c8d9e0
Revises: a1b2c3d4e5f6
Create Date: 2025-12-03

This migration creates the subtask_attachments table with:
- LONGBLOB for binary_data to support large files (up to 4GB)
- LONGTEXT for extracted_text to support large documents
- LONGTEXT for image_base64 to support base64-encoded images for vision models
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.mysql import LONGBLOB, LONGTEXT

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f5a6b7c8d9e0"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create subtask_attachments table with proper column types for large data."""
    op.create_table(
        "subtask_attachments",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        # subtask_id: 0 means unlinked, > 0 means linked to a subtask (no FK constraint)
        sa.Column("subtask_id", sa.Integer(), nullable=False, default=0),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("file_extension", sa.String(20), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        # Use LONGBLOB for binary_data to support large files (up to 4GB)
        sa.Column("binary_data", LONGBLOB(), nullable=False),
        # Use LONGTEXT for image_base64 to support large base64-encoded images
        # Note: MySQL doesn't allow default values for TEXT/BLOB columns, so we use nullable=True
        sa.Column("image_base64", LONGTEXT(), nullable=True),
        # Use LONGTEXT for extracted_text to support large documents
        # Note: MySQL doesn't allow default values for TEXT/BLOB columns, so we use nullable=True
        sa.Column("extracted_text", LONGTEXT(), nullable=True),
        sa.Column("text_length", sa.Integer(), nullable=False, default=0),
        sa.Column(
            "status",
            sa.Enum("uploading", "parsing", "ready", "failed", name="attachmentstatus"),
            nullable=False,
        ),
        sa.Column("error_message", sa.String(500), nullable=False, server_default=""),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id"),
        # No foreign key constraint for subtask_id to allow unlinked attachments
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )

    # Create indexes
    op.create_index("ix_subtask_attachments_id", "subtask_attachments", ["id"])
    op.create_index(
        "ix_subtask_attachments_subtask_id", "subtask_attachments", ["subtask_id"]
    )
    op.create_index(
        "ix_subtask_attachments_user_id", "subtask_attachments", ["user_id"]
    )


def downgrade() -> None:
    """Drop subtask_attachments table."""
    # Simply drop the table - this will automatically drop all indexes and constraints
    op.drop_table("subtask_attachments")