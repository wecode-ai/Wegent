# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add api_keys table for programmatic API access

Revision ID: i9j0k1l2m3n4
Revises: h8i9j0k1l2m3
Create Date: 2025-12-15 19:00:00.000000+08:00

This migration creates the api_keys table for storing API keys that allow
users to access Wegent's OpenAPI endpoints programmatically.
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "i9j0k1l2m3n4"
down_revision: Union[str, None] = "h8i9j0k1l2m3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create api_keys table."""
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS api_keys (
        id INT NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
        user_id INT NOT NULL DEFAULT 0 COMMENT 'User ID who owns this API key',
        key_hash VARCHAR(256) NOT NULL DEFAULT '' COMMENT 'SHA256 hash of the API key',
        key_prefix VARCHAR(16) NOT NULL DEFAULT '' COMMENT 'Display prefix of the key (e.g., wg-abc123...)',
        name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'User-defined name for this API key',
        expires_at DATETIME NOT NULL DEFAULT '9999-12-31 23:59:59' COMMENT 'Expiration time, 9999-12-31 means never expires',
        last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Last time this key was used',
        is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the key is active (1=active, 0=deleted)',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation timestamp',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
        PRIMARY KEY (id),
        UNIQUE KEY uniq_api_keys_key_hash (key_hash),
        KEY idx_api_keys_user_id (user_id),
        KEY idx_api_keys_id (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """
    )


def downgrade() -> None:
    """Drop api_keys table."""
    op.execute("DROP TABLE IF EXISTS api_keys")
