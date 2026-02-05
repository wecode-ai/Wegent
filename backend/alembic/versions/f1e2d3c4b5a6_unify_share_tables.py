# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unify sharing tables: migrate data and drop legacy tables.

This migration:
1. Migrates data from shared_teams to resource_members (if table exists)
2. Migrates data from shared_tasks to resource_members (if table exists)
3. Migrates data from task_members to resource_members (if table exists)
4. Drops the legacy tables (shared_teams, shared_tasks, task_members) if they exist
5. Adds user_id foreign key constraint to resource_members

Revision ID: f1e2d3c4b5a6
Revises: 26e05c6de5a5
Create Date: 2025-02-05

Migration rules:
- is_active=true -> status='approved', is_active=false -> status='rejected'
- Default permission_level: 'manage'
- task_members.status='ACTIVE' -> approved, 'REMOVED' -> rejected
- Use 0 as default for foreign key fields
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f1e2d3c4b5a6'
down_revision: Union[str, Sequence[str], None] = '26e05c6de5a5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def table_exists(conn, table_name: str) -> bool:
    """Check if a table exists in the current database."""
    result = conn.execute(sa.text("""
        SELECT COUNT(*)
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = :table_name
    """), {"table_name": table_name})
    return result.scalar() > 0


def upgrade() -> None:
    """Migrate data from legacy tables to resource_members and drop legacy tables."""
    conn = op.get_bind()

    # 1. Migrate shared_teams data to resource_members (if table exists)
    if table_exists(conn, 'shared_teams'):
        op.execute("""
        INSERT INTO resource_members (
            resource_type,
            resource_id,
            user_id,
            permission_level,
            status,
            invited_by_user_id,
            share_link_id,
            reviewed_by_user_id,
            reviewed_at,
            copied_resource_id,
            requested_at,
            created_at,
            updated_at
        )
        SELECT
            'Team' as resource_type,
            team_id as resource_id,
            user_id,
            'manage' as permission_level,
            CASE WHEN is_active = 1 THEN 'approved' ELSE 'rejected' END as status,
            COALESCE(original_user_id, 0) as invited_by_user_id,
            0 as share_link_id,
            0 as reviewed_by_user_id,
            '1970-01-01 00:00:00' as reviewed_at,
            0 as copied_resource_id,
            created_at as requested_at,
            created_at,
            updated_at
        FROM shared_teams st
        WHERE NOT EXISTS (
            SELECT 1 FROM resource_members rm
            WHERE rm.resource_type = 'Team'
            AND rm.resource_id = st.team_id
            AND rm.user_id = st.user_id
        )
        """)
        # Drop table after migration
        op.drop_table('shared_teams')

    # 2. Migrate shared_tasks data to resource_members (if table exists)
    if table_exists(conn, 'shared_tasks'):
        op.execute("""
        INSERT INTO resource_members (
            resource_type,
            resource_id,
            user_id,
            permission_level,
            status,
            invited_by_user_id,
            share_link_id,
            reviewed_by_user_id,
            reviewed_at,
            copied_resource_id,
            requested_at,
            created_at,
            updated_at
        )
        SELECT
            'Task' as resource_type,
            task_id as resource_id,
            user_id,
            'manage' as permission_level,
            CASE WHEN is_active = 1 THEN 'approved' ELSE 'rejected' END as status,
            COALESCE(original_user_id, 0) as invited_by_user_id,
            0 as share_link_id,
            0 as reviewed_by_user_id,
            '1970-01-01 00:00:00' as reviewed_at,
            COALESCE(copied_task_id, 0) as copied_resource_id,
            created_at as requested_at,
            created_at,
            updated_at
        FROM shared_tasks sts
        WHERE NOT EXISTS (
            SELECT 1 FROM resource_members rm
            WHERE rm.resource_type = 'Task'
            AND rm.resource_id = sts.task_id
            AND rm.user_id = sts.user_id
        )
        """)
        # Drop table after migration
        op.drop_table('shared_tasks')

    # 3. Migrate task_members data to resource_members (if table exists)
    if table_exists(conn, 'task_members'):
        op.execute("""
        INSERT INTO resource_members (
            resource_type,
            resource_id,
            user_id,
            permission_level,
            status,
            invited_by_user_id,
            share_link_id,
            reviewed_by_user_id,
            reviewed_at,
            copied_resource_id,
            requested_at,
            created_at,
            updated_at
        )
        SELECT
            'Task' as resource_type,
            task_id as resource_id,
            user_id,
            'manage' as permission_level,
            CASE WHEN status = 'ACTIVE' THEN 'approved' ELSE 'rejected' END as status,
            COALESCE(invited_by, 0) as invited_by_user_id,
            0 as share_link_id,
            0 as reviewed_by_user_id,
            '1970-01-01 00:00:00' as reviewed_at,
            0 as copied_resource_id,
            joined_at as requested_at,
            joined_at as created_at,
            updated_at
        FROM task_members tm
        WHERE NOT EXISTS (
            SELECT 1 FROM resource_members rm
            WHERE rm.resource_type = 'Task'
            AND rm.resource_id = tm.task_id
            AND rm.user_id = tm.user_id
        )
        """)
        # Drop table after migration
        op.drop_table('task_members')

    # 4. Update resource_members to ensure all NOT NULL constraints
    # Set default values for any NULL fields
    op.execute("""
    UPDATE resource_members
    SET
        invited_by_user_id = COALESCE(invited_by_user_id, 0),
        share_link_id = COALESCE(share_link_id, 0),
        reviewed_by_user_id = COALESCE(reviewed_by_user_id, 0),
        reviewed_at = COALESCE(reviewed_at, '1970-01-01 00:00:00'),
        copied_resource_id = COALESCE(copied_resource_id, 0)
    WHERE invited_by_user_id IS NULL
       OR share_link_id IS NULL
       OR reviewed_by_user_id IS NULL
       OR reviewed_at IS NULL
       OR copied_resource_id IS NULL
    """)

    # 5. Update share_links to ensure NOT NULL constraint on expires_at
    if table_exists(conn, 'share_links'):
        op.execute("""
        UPDATE share_links
        SET expires_at = '9999-12-31 23:59:59'
        WHERE expires_at IS NULL
        """)

        # 6. Update share_links expires_at to NOT NULL with default
        op.execute("""
        ALTER TABLE share_links
        MODIFY COLUMN expires_at DATETIME NOT NULL DEFAULT '9999-12-31 23:59:59'
        """)

    # 7. Update resource_members columns to NOT NULL with defaults
    op.execute("""
    ALTER TABLE resource_members
    MODIFY COLUMN user_id INT NOT NULL,
    MODIFY COLUMN invited_by_user_id INT NOT NULL DEFAULT 0,
    MODIFY COLUMN share_link_id INT NOT NULL DEFAULT 0,
    MODIFY COLUMN reviewed_by_user_id INT NOT NULL DEFAULT 0,
    MODIFY COLUMN reviewed_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00',
    MODIFY COLUMN copied_resource_id INT NOT NULL DEFAULT 0
    """)

    # 8. Add foreign key constraint (only if it doesn't exist)
    result = conn.execute(sa.text("""
        SELECT COUNT(*)
        FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = 'resource_members'
        AND CONSTRAINT_NAME = 'fk_resource_members_user_id'
    """))
    if result.scalar() == 0:
        op.execute("""
        ALTER TABLE resource_members
        ADD CONSTRAINT fk_resource_members_user_id
        FOREIGN KEY (user_id) REFERENCES users(id)
        """)


def downgrade() -> None:
    """Recreate legacy tables (without restoring data)."""
    conn = op.get_bind()

    # 1. Remove foreign key constraint from resource_members
    result = conn.execute(sa.text("""
        SELECT COUNT(*)
        FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = 'resource_members'
        AND CONSTRAINT_NAME = 'fk_resource_members_user_id'
    """))
    if result.scalar() > 0:
        op.execute("""
        ALTER TABLE resource_members
        DROP FOREIGN KEY fk_resource_members_user_id
        """)

    # 2. Recreate shared_teams table
    op.execute("""
    CREATE TABLE IF NOT EXISTS shared_teams (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        original_user_id INT NOT NULL,
        team_id INT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_shared_teams_id (id),
        KEY ix_shared_teams_user_id (user_id),
        KEY ix_shared_teams_original_user_id (original_user_id),
        KEY ix_shared_teams_team_id (team_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # 3. Recreate shared_tasks table
    op.execute("""
    CREATE TABLE IF NOT EXISTS shared_tasks (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        original_user_id INT NOT NULL,
        task_id INT NOT NULL,
        copied_task_id INT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY ix_shared_tasks_id (id),
        KEY ix_shared_tasks_user_id (user_id),
        KEY ix_shared_tasks_original_user_id (original_user_id),
        KEY ix_shared_tasks_task_id (task_id),
        KEY ix_shared_tasks_copied_task_id (copied_task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # 4. Recreate task_members table
    op.execute("""
    CREATE TABLE IF NOT EXISTS task_members (
        id INT NOT NULL AUTO_INCREMENT,
        task_id INT NOT NULL,
        user_id INT NOT NULL,
        invited_by INT,
        status ENUM('ACTIVE', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_task_members (task_id, user_id),
        KEY ix_task_members_id (id),
        KEY ix_task_members_task_id (task_id),
        KEY ix_task_members_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # Note: Data is not restored in downgrade. Manual data migration would be needed
    # if rollback is required with data preservation.
