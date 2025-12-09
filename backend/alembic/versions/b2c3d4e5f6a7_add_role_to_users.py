# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add role column to users table

Revision ID: b2c3d4e5f6a7
Revises: a6b7c8d9e0f1
Create Date: 2025-07-22 10:00:00.000000+08:00

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a6b7c8d9e0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add role column to users table.

    Values: 'admin', 'user'
    Default 'user' for existing users.
    Users with user_name='admin' will be set to role='admin'.
    """
    # Check if column already exists before adding
    op.execute(
        """
    SET @column_exists = (
        SELECT COUNT(*)
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'role'
    );
    """
    )

    op.execute(
        """
    SET @query = IF(@column_exists = 0,
        'ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT ''user'' AFTER is_active',
        'SELECT 1'
    );
    """
    )

    op.execute("PREPARE stmt FROM @query;")
    op.execute("EXECUTE stmt;")
    op.execute("DEALLOCATE PREPARE stmt;")

    # Set admin role for users with user_name='admin'
    op.execute(
        """
    UPDATE users SET role = 'admin' WHERE user_name = 'admin';
    """
    )


def downgrade() -> None:
    """Remove role column from users table."""
    op.drop_column("users", "role")
