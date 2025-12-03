# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add image_base64 field to subtask_attachments table for vision model support

Revision ID: add_image_base64
Revises: add_subtask_attachments
Create Date: 2025-12-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_image_base64'
down_revision: Union[str, None] = 'add_subtask_attachments'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add image_base64 column to subtask_attachments table."""
    op.add_column(
        'subtask_attachments',
        sa.Column('image_base64', sa.Text(), nullable=True)
    )


def downgrade() -> None:
    """Remove image_base64 column from subtask_attachments table."""
    op.drop_column('subtask_attachments', 'image_base64')
