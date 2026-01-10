# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add marketplace tables for Agent Marketplace feature

Revision ID: q7r8s9t0u1v2
Revises: p6q7r8s9t0u1
Create Date: 2025-01-11 10:00:00.000000

This migration adds:
1. team_marketplace table for marketplace team extended information
2. installed_teams table for user installation records
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "q7r8s9t0u1v2"
down_revision: Union[str, None] = "p6q7r8s9t0u1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create team_marketplace and installed_teams tables."""

    # Create team_marketplace table
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS team_marketplace (
        id INT NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
        team_id INT NOT NULL COMMENT 'Reference to kinds.id (user_id=0 Team)',
        category VARCHAR(50) NOT NULL DEFAULT 'other' COMMENT 'Category: development, office, creative, data_analysis, education, other',
        description TEXT NULL COMMENT 'Marketplace display description',
        icon VARCHAR(100) NULL COMMENT 'Marketplace display icon',
        allow_reference TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Allow reference mode installation',
        allow_copy TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Allow copy mode installation',
        install_count INT NOT NULL DEFAULT 0 COMMENT 'Installation count for statistics',
        is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Is published/active',
        published_at DATETIME NULL COMMENT 'Publish timestamp',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation timestamp',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
        PRIMARY KEY (id),
        UNIQUE KEY uk_team_id (team_id),
        KEY idx_tm_category (category),
        KEY idx_tm_is_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """
    )

    # Create installed_teams table
    op.execute(
        """
    CREATE TABLE IF NOT EXISTS installed_teams (
        id INT NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
        user_id INT NOT NULL COMMENT 'Installing user ID',
        marketplace_team_id INT NOT NULL COMMENT 'Reference to team_marketplace.id',
        install_mode VARCHAR(20) NOT NULL DEFAULT 'reference' COMMENT 'Installation mode: reference or copy',
        copied_team_id INT NULL COMMENT 'Team ID in user space for copy mode',
        is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Is active (false when uninstalled)',
        installed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Installation timestamp',
        uninstalled_at DATETIME NULL COMMENT 'Uninstallation timestamp',
        PRIMARY KEY (id),
        UNIQUE KEY uk_it_user_marketplace (user_id, marketplace_team_id),
        KEY idx_it_user_id (user_id),
        KEY idx_it_is_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """
    )


def downgrade() -> None:
    """Drop team_marketplace and installed_teams tables."""
    op.execute("DROP TABLE IF EXISTS installed_teams")
    op.execute("DROP TABLE IF EXISTS team_marketplace")
