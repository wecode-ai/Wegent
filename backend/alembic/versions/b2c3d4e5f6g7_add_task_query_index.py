# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add composite index for task query optimization

Revision ID: b2c3d4e5f6g7
Revises: a1b2c3d4e5f6
Create Date: 2025-12-01 15:40:00.000000+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b2c3d4e5f6g7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add composite index to optimize task queries.

    This index optimizes the query pattern used in get_user_tasks_lite:
    - user_id: for user filtering
    - kind: for resource type filtering
    - is_active: for active records
    - created_at DESC: for sorting

    This avoids MySQL "Out of sort memory" error by enabling index-based sorting.
    """
    # Check if index already exists before adding
    op.execute("""
    SET @index_exists = (
        SELECT COUNT(*)
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'kinds'
        AND INDEX_NAME = 'idx_user_kind_active_created'
    );
    """)

    op.execute("""
    SET @query = IF(@index_exists = 0,
        'CREATE INDEX idx_user_kind_active_created ON kinds(user_id, kind, is_active, created_at DESC)',
        'SELECT 1'
    );
    """)

    op.execute("PREPARE stmt FROM @query;")
    op.execute("EXECUTE stmt;")
    op.execute("DEALLOCATE PREPARE stmt;")


def downgrade() -> None:
    """Remove composite index from kinds table."""
    op.execute("DROP INDEX IF EXISTS idx_user_kind_active_created ON kinds;")
