# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add key_type and description fields to api_keys table for service key support

Revision ID: n4o5p6q7r8s9
Revises: m3n4o5p6q7r8
Create Date: 2025-12-29 19:00:00.000000+08:00

This migration adds key_type and description fields to the api_keys table
to support service keys for trusted service authentication.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "n4o5p6q7r8s9"
down_revision: Union[str, None] = "m3n4o5p6q7r8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add key_type and description columns to api_keys table."""
    # Add key_type column with default 'personal' for existing records
    op.execute(
        """
        ALTER TABLE api_keys
        ADD COLUMN key_type VARCHAR(20) NOT NULL DEFAULT 'personal'
            COMMENT 'Key type: personal or service'
        """
    )

    # Add description column (nullable)
    op.execute(
        """
        ALTER TABLE api_keys
        ADD COLUMN description VARCHAR(500) NULL DEFAULT NULL
            COMMENT 'Key description'
        """
    )

    # Add index on key_type for efficient filtering
    op.execute(
        """
        CREATE INDEX idx_api_keys_key_type ON api_keys (key_type)
        """
    )


def downgrade() -> None:
    """Remove key_type and description columns from api_keys table."""
    op.execute("DROP INDEX idx_api_keys_key_type ON api_keys")
    op.execute("ALTER TABLE api_keys DROP COLUMN description")
    op.execute("ALTER TABLE api_keys DROP COLUMN key_type")
