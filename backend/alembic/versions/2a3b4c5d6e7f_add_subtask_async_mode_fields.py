# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add_subtask_async_mode_fields

Revision ID: 2a3b4c5d6e7f
Revises: 1a2b3c4d5e6f
Create Date: 2025-07-01 10:00:00.000000+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2a3b4c5d6e7f'
down_revision: Union[str, Sequence[str], None] = '1a2b3c4d5e6f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add async mode fields to subtasks table and update status enum."""

    # First, modify the status enum to include WAITING
    # MySQL requires recreating the column with new enum values
    op.execute("""
    ALTER TABLE subtasks
    MODIFY COLUMN status ENUM('PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETE')
    NOT NULL DEFAULT 'PENDING'
    """)

    # Add new columns for async mode support
    op.execute("""
    ALTER TABLE subtasks
    ADD COLUMN IF NOT EXISTS waiting_for VARCHAR(50) NULL COMMENT 'Event type being waited for (e.g., ci_pipeline, approval)'
    """)

    op.execute("""
    ALTER TABLE subtasks
    ADD COLUMN IF NOT EXISTS waiting_since DATETIME NULL COMMENT 'Timestamp when entered WAITING state'
    """)

    op.execute("""
    ALTER TABLE subtasks
    ADD COLUMN IF NOT EXISTS waiting_timeout INT NULL COMMENT 'Timeout in seconds, optional'
    """)

    op.execute("""
    ALTER TABLE subtasks
    ADD COLUMN IF NOT EXISTS resume_count INT NOT NULL DEFAULT 0 COMMENT 'Number of times session has been resumed'
    """)

    op.execute("""
    ALTER TABLE subtasks
    ADD COLUMN IF NOT EXISTS max_resume_count INT NOT NULL DEFAULT 5 COMMENT 'Maximum allowed resume count'
    """)

    # Add index for efficient lookup of WAITING subtasks
    op.execute("""
    CREATE INDEX IF NOT EXISTS ix_subtasks_waiting_status
    ON subtasks (status, waiting_for)
    """)


def downgrade() -> None:
    """Remove async mode fields and revert status enum."""

    # Drop the index first
    op.execute("""
    DROP INDEX IF EXISTS ix_subtasks_waiting_status ON subtasks
    """)

    # Remove the new columns
    op.execute("""
    ALTER TABLE subtasks
    DROP COLUMN IF EXISTS waiting_for
    """)

    op.execute("""
    ALTER TABLE subtasks
    DROP COLUMN IF EXISTS waiting_since
    """)

    op.execute("""
    ALTER TABLE subtasks
    DROP COLUMN IF EXISTS waiting_timeout
    """)

    op.execute("""
    ALTER TABLE subtasks
    DROP COLUMN IF EXISTS resume_count
    """)

    op.execute("""
    ALTER TABLE subtasks
    DROP COLUMN IF EXISTS max_resume_count
    """)

    # Revert the status enum (remove WAITING)
    # First update any WAITING rows to PENDING
    op.execute("""
    UPDATE subtasks SET status = 'PENDING' WHERE status = 'WAITING'
    """)

    op.execute("""
    ALTER TABLE subtasks
    MODIFY COLUMN status ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETE')
    NOT NULL DEFAULT 'PENDING'
    """)
