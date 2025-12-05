# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add minio_object_key to subtask_attachments for MinIO storage

Revision ID: add_minio_object_key
Revises: add_subtask_attachments
Create Date: 2025-12-05

This migration adds minio_object_key field to subtask_attachments table to support
MinIO object storage. When set, file binary data is stored in MinIO at this key path.
When NULL, file binary data is in the binary_data column (legacy data).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_minio_object_key'
down_revision: Union[str, None] = 'add_subtask_attachments'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add minio_object_key column to subtask_attachments table."""
    op.add_column(
        'subtask_attachments',
        sa.Column('minio_object_key', sa.String(500), nullable=True, default=None)
    )


def downgrade() -> None:
    """Remove minio_object_key column from subtask_attachments table."""
    op.drop_column('subtask_attachments', 'minio_object_key')
