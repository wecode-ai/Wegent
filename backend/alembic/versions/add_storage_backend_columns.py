# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add storage backend columns to subtask_attachments

Revision ID: add_storage_backend_columns
Revises: add_subtask_attachments
Create Date: 2025-12-08

This migration adds columns to support pluggable storage backends:
- storage_key: Reference key for external storage (format: attachments/{id})
- storage_backend: Type of storage backend used (mysql, s3, minio, etc.)
- Modifies binary_data to be nullable for external storage scenarios
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import LONGBLOB


# revision identifiers, used by Alembic.
revision: str = 'add_storage_backend_columns'
down_revision: Union[str, None] = 'add_subtask_attachments'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add storage backend columns and make binary_data nullable."""
    # Add storage_key column for external storage reference
    op.add_column(
        'subtask_attachments',
        sa.Column('storage_key', sa.String(500), nullable=True)
    )

    # Add storage_backend column to identify which backend stores the data
    op.add_column(
        'subtask_attachments',
        sa.Column('storage_backend', sa.String(50), nullable=True)
    )

    # Create index on storage_key for faster lookups
    op.create_index(
        'ix_subtask_attachments_storage_key',
        'subtask_attachments',
        ['storage_key']
    )

    # Modify binary_data column to be nullable
    # This allows external storage backends to store data externally
    # while keeping binary_data NULL in the database
    op.alter_column(
        'subtask_attachments',
        'binary_data',
        existing_type=LONGBLOB(),
        nullable=True
    )


def downgrade() -> None:
    """Remove storage backend columns and revert binary_data to non-nullable."""
    # First, ensure all binary_data values are not NULL
    # (this may fail if there are external storage records without binary_data)
    op.execute(
        "UPDATE subtask_attachments SET binary_data = '' WHERE binary_data IS NULL"
    )

    # Revert binary_data to non-nullable
    op.alter_column(
        'subtask_attachments',
        'binary_data',
        existing_type=LONGBLOB(),
        nullable=False
    )

    # Drop index
    op.drop_index('ix_subtask_attachments_storage_key', table_name='subtask_attachments')

    # Drop columns
    op.drop_column('subtask_attachments', 'storage_backend')
    op.drop_column('subtask_attachments', 'storage_key')
