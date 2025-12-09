# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add storage backend columns to subtask_attachments table

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2025-12-05

This migration adds storage_key and storage_backend columns to support
pluggable storage backends (S3, MinIO, etc.) while maintaining backward
compatibility with MySQL-based storage.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e4f5a6b7c8d9"
down_revision: Union[str, None] = "d3e4f5a6b7c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add storage backend columns to subtask_attachments table."""
    # Add storage_key column (NOT NULL with empty string default)
    # Empty string means data is stored in MySQL binary_data column
    op.add_column(
        "subtask_attachments",
        sa.Column("storage_key", sa.String(500), nullable=False, server_default=""),
    )

    # Add storage_backend column (NOT NULL with 'mysql' default)
    # Indicates which storage backend is used: 'mysql', 's3', 'minio', etc.
    op.add_column(
        "subtask_attachments",
        sa.Column(
            "storage_backend", sa.String(50), nullable=False, server_default="mysql"
        ),
    )

    # Note: server_default will automatically set default values for existing records
    # binary_data remains NOT NULL
    # When using external storage (storage_backend != 'mysql'),
    # binary_data will store empty bytes (b'') as a marker


def downgrade() -> None:
    """Remove storage backend columns from subtask_attachments table."""
    # Before downgrade, ensure all data is migrated back to MySQL if needed
    # This migration assumes that downgrade only happens when all data is in MySQL

    # Drop the storage columns
    op.drop_column("subtask_attachments", "storage_backend")
    op.drop_column("subtask_attachments", "storage_key")