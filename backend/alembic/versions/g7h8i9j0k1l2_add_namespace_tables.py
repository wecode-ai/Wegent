# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add namespace and namespace_members tables

Revision ID: g7h8i9j0k1l2
Revises: 3e3f7f525e2d
Create Date: 2025-12-09 22:00:00.000000+08:00

This migration adds two new tables for Group (Namespace) functionality:
- namespace: Stores group information
- namespace_members: Stores group membership relationships
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "g7h8i9j0k1l2"
down_revision: Union[str, None] = "3e3f7f525e2d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create namespace and namespace_members tables."""

    # Create namespace table
    op.execute(
        """
        CREATE TABLE `namespace` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Unique identifier, immutable after creation. Sub-groups use prefix format (e.g., aaa/bbb)',
          `display_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Display name, can be modified',
          `owner_user_id` int(11) NOT NULL COMMENT 'Group owner user ID',
          `visibility` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'private' COMMENT 'Visibility: private, internal, public',
          `description` text COLLATE utf8mb4_unicode_ci COMMENT 'Group description',
          `is_active` tinyint(1) DEFAULT '1' COMMENT 'Is group active',
          `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation timestamp',
          `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
          PRIMARY KEY (`id`),
          UNIQUE KEY `idx_namespace_name_unique` (`name`),
          KEY `idx_namespace_owner_user_id` (`owner_user_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Group (Namespace) table for resource organization'
        """
    )

    # Create namespace_members table
    op.execute(
        """
        CREATE TABLE `namespace_members` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `group_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'References namespace.name',
          `user_id` int(11) NOT NULL COMMENT 'Member user ID',
          `role` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Member role: Owner, Maintainer, Developer, Reporter',
          `invited_by_user_id` int(11) DEFAULT NULL COMMENT 'User ID who invited this member',
          `is_active` tinyint(1) DEFAULT '1' COMMENT 'Is membership active',
          `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT 'Membership creation timestamp',
          `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
          PRIMARY KEY (`id`),
          UNIQUE KEY `idx_group_user` (`group_name`,`user_id`),
          KEY `idx_namespace_members_user_id` (`user_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Group membership table'
        """
    )


def downgrade() -> None:
    """Drop namespace and namespace_members tables."""

    op.execute("DROP TABLE IF EXISTS `namespace_members`")
    op.execute("DROP TABLE IF EXISTS `namespace`")
