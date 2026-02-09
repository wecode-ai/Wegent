# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unify sharing tables: migrate data and rename legacy tables to backup_ prefix.

This migration:
1. Migrates data from shared_teams to resource_members (if table exists)
2. Migrates data from shared_tasks to resource_members (if table exists)
3. Migrates data from task_members to resource_members (if table exists)
4. Renames the legacy tables to backup_ prefix (backup_shared_teams, backup_shared_tasks, backup_task_members) if they exist

Revision ID: f1e2d3c4b5a6
Revises: 26e05c6de5a5
Create Date: 2025-02-05

Migration rules:
- is_active=true -> status='approved', is_active=false -> status='rejected'
- Default permission_level: 'manage'
- task_members.status='ACTIVE' -> approved, 'REMOVED' -> rejected
- Use 0 as default for optional foreign key fields (matches ResourceMember model NOT NULL constraints)
"""
from datetime import datetime
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f1e2d3c4b5a6"
down_revision: Union[str, Sequence[str], None] = "26e05c6de5a5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Timestamp constants
EPOCH_TIMESTAMP = "1970-01-01 00:00:00"
FAR_FUTURE_TIMESTAMP = "9999-12-31 23:59:59"


def table_exists(conn, table_name: str) -> bool:
    """Check if a table exists using SQLAlchemy Inspector (DB-agnostic)."""
    inspector = inspect(conn)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    """Migrate data from legacy tables to resource_members and rename legacy tables to backup_ prefix."""
    conn = op.get_bind()

    # 1. Migrate shared_teams data to resource_members (if table exists)
    if table_exists(conn, "shared_teams"):
        op.execute(
            f"""
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
            original_user_id as invited_by_user_id,
            0 as share_link_id,
            0 as reviewed_by_user_id,
            '{EPOCH_TIMESTAMP}' as reviewed_at,
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
        """
        )
        # Rename table to backup_ prefix after migration
        op.rename_table("shared_teams", "backup_shared_teams")

    # 2. Migrate shared_tasks data to resource_members (if table exists)
    if table_exists(conn, "shared_tasks"):
        op.execute(
            f"""
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
            original_task_id as resource_id,
            user_id,
            'manage' as permission_level,
            CASE WHEN is_active = 1 THEN 'approved' ELSE 'rejected' END as status,
            original_user_id as invited_by_user_id,
            0 as share_link_id,
            0 as reviewed_by_user_id,
            '{EPOCH_TIMESTAMP}' as reviewed_at,
            copied_task_id as copied_resource_id,
            created_at as requested_at,
            created_at,
            updated_at
        FROM shared_tasks sts
        WHERE NOT EXISTS (
            SELECT 1 FROM resource_members rm
            WHERE rm.resource_type = 'Task'
            AND rm.resource_id = sts.original_task_id
            AND rm.user_id = sts.user_id
        )
        """
        )
        # Rename table to backup_ prefix after migration
        op.rename_table("shared_tasks", "backup_shared_tasks")

    # 3. Migrate task_members data to resource_members (if table exists)
    if table_exists(conn, "task_members"):
        op.execute(
            f"""
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
            '{EPOCH_TIMESTAMP}' as reviewed_at,
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
        """
        )
        # Rename table to backup_ prefix after migration
        op.rename_table("task_members", "backup_task_members")

    # 4. Update share_links to ensure NOT NULL constraint on expires_at
    if table_exists(conn, "share_links"):
        op.execute(
            f"""
        UPDATE share_links
        SET expires_at = '{FAR_FUTURE_TIMESTAMP}'
        WHERE expires_at IS NULL
        """
        )

        # Use portable Alembic API to alter share_links.expires_at
        with op.batch_alter_table("share_links") as batch_op:
            batch_op.alter_column(
                "expires_at",
                existing_type=sa.DateTime(),
                nullable=False,
                server_default=FAR_FUTURE_TIMESTAMP,
            )

    # 5. Update resource_members columns using portable Alembic API
    # First, set default values for any NULL fields before making them NOT NULL
    op.execute(
        f"""
    UPDATE resource_members
    SET
        invited_by_user_id = COALESCE(invited_by_user_id, 0),
        share_link_id = COALESCE(share_link_id, 0),
        reviewed_by_user_id = COALESCE(reviewed_by_user_id, 0),
        reviewed_at = COALESCE(reviewed_at, '{EPOCH_TIMESTAMP}'),
        copied_resource_id = COALESCE(copied_resource_id, 0)
    WHERE invited_by_user_id IS NULL
       OR share_link_id IS NULL
       OR reviewed_by_user_id IS NULL
       OR reviewed_at IS NULL
       OR copied_resource_id IS NULL
    """
    )

    # Use portable Alembic API to alter resource_members columns
    with op.batch_alter_table("resource_members") as batch_op:
        batch_op.alter_column(
            "user_id",
            existing_type=sa.Integer(),
            nullable=False,
        )
        batch_op.alter_column(
            "invited_by_user_id",
            existing_type=sa.Integer(),
            nullable=False,
            server_default="0",
        )
        batch_op.alter_column(
            "share_link_id",
            existing_type=sa.Integer(),
            nullable=False,
            server_default="0",
        )
        batch_op.alter_column(
            "reviewed_by_user_id",
            existing_type=sa.Integer(),
            nullable=False,
            server_default="0",
        )
        batch_op.alter_column(
            "reviewed_at",
            existing_type=sa.DateTime(),
            nullable=False,
            server_default=EPOCH_TIMESTAMP,
        )
        batch_op.alter_column(
            "copied_resource_id",
            existing_type=sa.Integer(),
            nullable=False,
            server_default="0",
        )


def downgrade() -> None:
    """Rename backup tables back to original names (without restoring data from resource_members)."""
    conn = op.get_bind()

    # 1. Rename backup_shared_teams back to shared_teams (if exists)
    if table_exists(conn, "backup_shared_teams"):
        op.rename_table("backup_shared_teams", "shared_teams")

    # 2. Rename backup_shared_tasks back to shared_tasks (if exists)
    if table_exists(conn, "backup_shared_tasks"):
        op.rename_table("backup_shared_tasks", "shared_tasks")

    # 3. Rename backup_task_members back to task_members (if exists)
    if table_exists(conn, "backup_task_members"):
        op.rename_table("backup_task_members", "task_members")

    # Note: Data migrated to resource_members is not restored in downgrade.
    # The backup tables contain the original data in their original state.
