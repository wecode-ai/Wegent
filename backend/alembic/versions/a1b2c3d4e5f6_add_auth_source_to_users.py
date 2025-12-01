# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add auth_source column to users table

Revision ID: a1b2c3d4e5f6
Revises: 1a2b3c4d5e6f
Create Date: 2025-07-21 10:00:00.000000+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '1a2b3c4d5e6f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add auth_source column to users table.

    Values: 'password', 'oidc', 'unknown'
    Default 'unknown' for existing users.
    """
    # Check if column already exists before adding
    op.execute("""
    SET @column_exists = (
        SELECT COUNT(*)
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'auth_source'
    );
    """)

    op.execute("""
    SET @query = IF(@column_exists = 0,
        'ALTER TABLE users ADD COLUMN auth_source VARCHAR(20) NOT NULL DEFAULT ''unknown'' AFTER is_active',
        'SELECT 1'
    );
    """)

    op.execute("PREPARE stmt FROM @query;")
    op.execute("EXECUTE stmt;")
    op.execute("DEALLOCATE PREPARE stmt;")


def downgrade() -> None:
    """Remove auth_source column from users table."""
    op.drop_column('users', 'auth_source')
