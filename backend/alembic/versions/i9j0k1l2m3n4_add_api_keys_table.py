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

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "i9j0k1l2m3n4"
down_revision: Union[str, None] = "h8i9j0k1l2m3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create api_keys table."""
    op.execute("""
    CREATE TABLE IF NOT EXISTS api_keys (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        key_hash VARCHAR(256) NOT NULL,
        key_prefix VARCHAR(16) NOT NULL,
        name VARCHAR(100) NOT NULL,
        expires_at DATETIME NOT NULL DEFAULT '9999-12-31 23:59:59',
        last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_api_keys_key_hash (key_hash),
        KEY ix_api_keys_user_id (user_id),
        KEY ix_api_keys_id (id),
        CONSTRAINT fk_api_keys_user_id FOREIGN KEY (user_id)
            REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)


def downgrade() -> None:
    """Drop api_keys table."""
    op.execute("DROP TABLE IF EXISTS api_keys")
