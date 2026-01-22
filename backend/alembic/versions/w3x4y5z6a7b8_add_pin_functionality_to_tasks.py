# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add pin functionality to tasks

Revision ID: w3x4y5z6a7b8
Revises: v2w3x4y5z6a7
Create Date: 2026-01-21

This migration adds pin functionality for tasks:
1. Adds is_pinned column (boolean) to tasks table
2. Adds pinned_at column (datetime) to tasks table
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "w3x4y5z6a7b8"
down_revision: Union[str, None] = "v2w3x4y5z6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add is_pinned and pinned_at columns to tasks table."""
    from sqlalchemy import inspect

    conn = op.get_bind()
    inspector = inspect(conn)

    columns = [col["name"] for col in inspector.get_columns("tasks")]

    # Add is_pinned column if not exists
    if "is_pinned" not in columns:
        op.execute(
            """
            ALTER TABLE tasks
            ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Whether the task is pinned to top'
            """
        )

        # Add index on is_pinned for faster sorting queries
        op.execute(
            """
            ALTER TABLE tasks ADD INDEX idx_tasks_is_pinned (is_pinned)
            """
        )

    # Add pinned_at column if not exists
    if "pinned_at" not in columns:
        op.execute(
            """
            ALTER TABLE tasks
            ADD COLUMN pinned_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00' COMMENT 'Time when the task was pinned'
            """
        )


def downgrade() -> None:
    """Remove is_pinned and pinned_at columns from tasks table."""
    # Drop index on is_pinned
    op.execute("ALTER TABLE tasks DROP INDEX idx_tasks_is_pinned")

    # Drop columns
    op.execute("ALTER TABLE tasks DROP COLUMN is_pinned")
    op.execute("ALTER TABLE tasks DROP COLUMN pinned_at")
