# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add subtask_attachments table for file upload support

Revision ID: add_subtask_attachments
Revises: 
Create Date: 2025-12-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_subtask_attachments'
down_revision: Union[str, None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create subtask_attachments table."""
    op.create_table(
        'subtask_attachments',
        sa.Column('id', sa.Integer(), nullable=False, autoincrement=True),
        sa.Column('subtask_id', sa.Integer(), nullable=True),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('original_filename', sa.String(255), nullable=False),
        sa.Column('file_extension', sa.String(20), nullable=False),
        sa.Column('file_size', sa.Integer(), nullable=False),
        sa.Column('mime_type', sa.String(100), nullable=False),
        sa.Column('binary_data', sa.LargeBinary(), nullable=False),
        sa.Column('extracted_text', sa.Text(), nullable=True),
        sa.Column('text_length', sa.Integer(), nullable=True),
        sa.Column('status', sa.Enum('uploading', 'parsing', 'ready', 'failed', name='attachmentstatus'), nullable=False),
        sa.Column('error_message', sa.String(500), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['subtask_id'], ['subtasks.id'], ondelete='CASCADE'),
        mysql_charset='utf8mb4',
        mysql_collate='utf8mb4_unicode_ci',
        mysql_engine='InnoDB'
    )
    
    # Create indexes
    op.create_index('ix_subtask_attachments_id', 'subtask_attachments', ['id'])
    op.create_index('ix_subtask_attachments_subtask_id', 'subtask_attachments', ['subtask_id'])
    op.create_index('ix_subtask_attachments_user_id', 'subtask_attachments', ['user_id'])


def downgrade() -> None:
    """Drop subtask_attachments table."""
    op.drop_index('ix_subtask_attachments_user_id', table_name='subtask_attachments')
    op.drop_index('ix_subtask_attachments_subtask_id', table_name='subtask_attachments')
    op.drop_index('ix_subtask_attachments_id', table_name='subtask_attachments')
    op.drop_table('subtask_attachments')
    
    # Drop the enum type
    op.execute("DROP TYPE IF EXISTS attachmentstatus")