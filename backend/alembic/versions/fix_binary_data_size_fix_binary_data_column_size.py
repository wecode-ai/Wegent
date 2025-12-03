# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fix binary_data column size to LONGBLOB for large file support

Revision ID: fix_binary_data_size
Revises: add_subtask_attachments
Create Date: 2025-12-03

This migration changes the binary_data column from BLOB (64KB max) to LONGBLOB (4GB max)
to support larger file uploads like PDFs and documents.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = 'fix_binary_data_size'
down_revision: Union[str, None] = 'add_subtask_attachments'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Change binary_data column to LONGBLOB for MySQL."""
    # Use MySQL-specific LONGBLOB type for large file support
    op.alter_column(
        'subtask_attachments',
        'binary_data',
        existing_type=sa.LargeBinary(),
        type_=mysql.LONGBLOB(),
        existing_nullable=False
    )
    
    # Also change extracted_text to LONGTEXT for large documents
    op.alter_column(
        'subtask_attachments',
        'extracted_text',
        existing_type=sa.Text(),
        type_=mysql.LONGTEXT(),
        existing_nullable=True
    )


def downgrade() -> None:
    """Revert to original column types."""
    op.alter_column(
        'subtask_attachments',
        'binary_data',
        existing_type=mysql.LONGBLOB(),
        type_=sa.LargeBinary(),
        existing_nullable=False
    )
    
    op.alter_column(
        'subtask_attachments',
        'extracted_text',
        existing_type=mysql.LONGTEXT(),
        type_=sa.Text(),
        existing_nullable=True
    )