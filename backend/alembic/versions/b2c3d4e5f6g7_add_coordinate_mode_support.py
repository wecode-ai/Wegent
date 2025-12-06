# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add coordinate mode support

Revision ID: b2c3d4e5f6g7
Revises: a1b2c3d4e5f6
Create Date: 2025-07-01 10:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6g7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add WAITING_INPUT status and subtask_metadata column for coordinate mode support."""

    # Add WAITING_INPUT to subtask status enum
    # MySQL requires recreating the enum type
    op.execute("""
    ALTER TABLE subtasks
    MODIFY COLUMN status ENUM('PENDING', 'RUNNING', 'WAITING_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETE')
    NOT NULL DEFAULT 'PENDING'
    """)

    # Add subtask_metadata column for coordinate mode metadata
    # Use standard ALTER TABLE ADD COLUMN syntax (MySQL doesn't support IF NOT EXISTS)
    from sqlalchemy import inspect
    from alembic import op as alembic_op

    bind = alembic_op.get_bind()
    inspector = inspect(bind)
    columns = [col['name'] for col in inspector.get_columns('subtasks')]

    if 'subtask_metadata' not in columns:
        op.execute("""
        ALTER TABLE subtasks
        ADD COLUMN subtask_metadata JSON NULL
        """)


def downgrade() -> None:
    """Remove WAITING_INPUT status and subtask_metadata column."""

    # First update any WAITING_INPUT status to PENDING before removing from enum
    op.execute("""
    UPDATE subtasks SET status = 'PENDING' WHERE status = 'WAITING_INPUT'
    """)

    # Remove WAITING_INPUT from subtask status enum
    op.execute("""
    ALTER TABLE subtasks
    MODIFY COLUMN status ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETE')
    NOT NULL DEFAULT 'PENDING'
    """)

    # Drop subtask_metadata column
    op.execute("""
    ALTER TABLE subtasks
    DROP COLUMN subtask_metadata
    """)
