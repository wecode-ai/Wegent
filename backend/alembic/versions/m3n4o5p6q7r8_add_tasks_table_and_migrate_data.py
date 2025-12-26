"""add_tasks_table_and_migrate_data

Revision ID: m3n4o5p6q7r8
Revises: l2m3n4o5p6q7
Create Date: 2025-12-23 16:30:00.000000+08:00

This migration creates a new 'tasks' table for storing Task and Workspace resources,
migrates existing data from the 'kinds' table, and removes the migrated data from 'kinds'.

The migration preserves original IDs to maintain referential integrity with the 'subtasks' table.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "m3n4o5p6q7r8"
down_revision: Union[str, Sequence[str], None] = "l2m3n4o5p6q7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    Upgrade schema:
    1. Create the new 'tasks' table
    2. Migrate Task and Workspace data from 'kinds' to 'tasks' (preserving IDs)
    3. Delete migrated data from 'kinds' table
    """
    # Step 1: Create the new 'tasks' table
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS `tasks` (
            `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
            `user_id` int NOT NULL DEFAULT '0' COMMENT 'User ID, references users.id',
            `kind` varchar(50) NOT NULL DEFAULT '' COMMENT 'Resource type: Task/Workspace',
            `name` varchar(100) NOT NULL DEFAULT '' COMMENT 'Resource name',
            `namespace` varchar(100) NOT NULL DEFAULT 'default' COMMENT 'Namespace',
            `json` json NOT NULL COMMENT 'Resource-specific data (JSON)',
            `is_active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Active flag',
            `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
            `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_user_kind_name_namespace` (`user_id`,`kind`,`name`,`namespace`),
            KEY `idx_user_id` (`user_id`),
            KEY `idx_kind` (`kind`),
            KEY `idx_created_at` (`created_at`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """
    )

    # Step 2: Migrate data from 'kinds' to 'tasks', preserving original IDs
    # MySQL automatically updates AUTO_INCREMENT when explicitly inserting IDs
    op.execute(
        """
        INSERT INTO tasks (id, user_id, kind, name, namespace, json, is_active, created_at, updated_at)
        SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at
        FROM kinds
        WHERE kind IN ('Task', 'Workspace')
        """
    )

    # Step 3: Hard delete migrated data from 'kinds' table
    op.execute(
        """
        DELETE FROM kinds WHERE kind IN ('Task', 'Workspace')
        """
    )


def downgrade() -> None:
    """
    Downgrade schema:
    1. Migrate data back from 'tasks' to 'kinds'
    2. Drop the 'tasks' table
    """
    # Step 1: Migrate data back from 'tasks' to 'kinds', preserving IDs
    # MySQL automatically updates AUTO_INCREMENT when explicitly inserting IDs
    op.execute(
        """
        INSERT INTO kinds (id, user_id, kind, name, namespace, json, is_active, created_at, updated_at)
        SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at
        FROM tasks
        """
    )

    # Step 2: Drop the 'tasks' table
    op.drop_table("tasks")
