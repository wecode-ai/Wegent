# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add storage backend columns to subtask_attachments table

Revision ID: add_storage_backend_columns
Revises: add_subtask_attachments
Create Date: 2025-12-05

This migration adds storage_key and storage_backend columns to support
pluggable storage backends (S3, MinIO, etc.) while maintaining backward
compatibility with MySQL-based storage.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "add_storage_backend_columns"
down_revision: Union[str, None] = "add_subtask_attachments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add storage backend columns to subtask_attachments table."""
    # Add storage_key column for external storage reference
    op.add_column(
        "subtask_attachments", sa.Column("storage_key", sa.String(500), nullable=True)
    )

    # Add storage_backend column to track which backend stores the data
    op.add_column(
        "subtask_attachments",
        sa.Column("storage_backend", sa.String(50), nullable=True),
    )

    # Make binary_data nullable to support external storage backends
    # When using external storage, binary_data can be NULL
    op.alter_column(
        "subtask_attachments",
        "binary_data",
        existing_type=sa.LargeBinary(),
        nullable=True,
    )

    # Update existing records to have 'mysql' as storage_backend
    # This ensures backward compatibility
    op.execute(
        "UPDATE subtask_attachments SET storage_backend = 'mysql' WHERE storage_backend IS NULL"
    )


def downgrade() -> None:
    """Remove storage backend columns from subtask_attachments table."""
    # First, ensure all records have binary_data before making it non-nullable
    # This migration assumes that downgrade only happens when all data is in MySQL

    # Make binary_data non-nullable again
    op.alter_column(
        "subtask_attachments",
        "binary_data",
        existing_type=sa.LargeBinary(),
        nullable=False,
    )

    # Drop the storage columns
    op.drop_column("subtask_attachments", "storage_backend")
    op.drop_column("subtask_attachments", "storage_key")
