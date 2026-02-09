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
- Use 0 as default for optional foreign key fields (matches ResourceMember model NOT NULL constraints)
"""
from datetime import datetime
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f1e2d3c4b5a6'
down_revision: Union[str, Sequence[str], None] = '26e05c6de5a5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Timestamp constants
EPOCH_TIMESTAMP = '1970-01-01 00:00:00'
FAR_FUTURE_TIMESTAMP = '9999-12-31 23:59:59'


def table_exists(conn, table_name: str) -> bool:
    """Check if a table exists using SQLAlchemy Inspector (DB-agnostic)."""
    inspector = inspect(conn)
    return table_name in inspector.get_table_names()


def upgrade() -> None:
    """Migrate data from legacy tables to resource_members and drop legacy tables."""
    conn = op.get_bind()
    dialect = op.get_context().dialect.name

    # 1. Migrate shared_teams data to resource_members (if table exists)
    if table_exists(conn, 'shared_teams'):
        op.execute(f"""
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
        """)
        # Drop table after migration
        op.drop_table('shared_teams')

    # 2. Migrate shared_tasks data to resource_members (if table exists)
    if table_exists(conn, 'shared_tasks'):
        op.execute(f"""
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
        """)
        # Drop table after migration
        op.drop_table('shared_tasks')

    # 3. Migrate task_members data to resource_members (if table exists)
    if table_exists(conn, 'task_members'):
        op.execute(f"""
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
        """)
        # Drop table after migration
        op.drop_table('task_members')

    # 4. Update share_links to ensure NOT NULL constraint on expires_at
    if table_exists(conn, 'share_links'):
        op.execute(f"""
        UPDATE share_links
        SET expires_at = '{FAR_FUTURE_TIMESTAMP}'
        WHERE expires_at IS NULL
        """)

        # Use portable Alembic API to alter share_links.expires_at
        with op.batch_alter_table('share_links') as batch_op:
            batch_op.alter_column(
                'expires_at',
                existing_type=sa.DateTime(),
                nullable=False,
                server_default=FAR_FUTURE_TIMESTAMP,
            )

    # 5. Update resource_members columns using portable Alembic API
    # First, set default values for any NULL fields before making them NOT NULL
    op.execute(f"""
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
    """)

    # Use portable Alembic API to alter resource_members columns
    with op.batch_alter_table('resource_members') as batch_op:
        batch_op.alter_column(
            'user_id',
            existing_type=sa.Integer(),
            nullable=False,
        )
        batch_op.alter_column(
            'invited_by_user_id',
            existing_type=sa.Integer(),
            nullable=False,
            server_default='0',
        )
        batch_op.alter_column(
            'share_link_id',
            existing_type=sa.Integer(),
            nullable=False,
            server_default='0',
        )
        batch_op.alter_column(
            'reviewed_by_user_id',
            existing_type=sa.Integer(),
            nullable=False,
            server_default='0',
        )
        batch_op.alter_column(
            'reviewed_at',
            existing_type=sa.DateTime(),
            nullable=False,
            server_default=EPOCH_TIMESTAMP,
        )
        batch_op.alter_column(
            'copied_resource_id',
            existing_type=sa.Integer(),
            nullable=False,
            server_default='0',
        )



def downgrade() -> None:
    """Recreate legacy tables (without restoring data)."""
    conn = op.get_bind()
    dialect = op.get_context().dialect.name

    # 1. Remove foreign key constraint from resource_members using portable API
    try:
        op.drop_constraint('fk_resource_members_user_id', 'resource_members', type_='foreignkey')
    except Exception:
        # Constraint may not exist
        pass

    # 2. Recreate shared_teams table using portable Alembic API
    op.create_table(
        'shared_teams',
        sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
        sa.Column('user_id', sa.Integer, nullable=False),
        sa.Column('original_user_id', sa.Integer, nullable=False),
        sa.Column('team_id', sa.Integer, nullable=False),
        sa.Column('is_active', sa.Boolean, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_index('ix_shared_teams_user_id', 'shared_teams', ['user_id'])
    op.create_index('ix_shared_teams_original_user_id', 'shared_teams', ['original_user_id'])
    op.create_index('ix_shared_teams_team_id', 'shared_teams', ['team_id'])

    # 3. Recreate shared_tasks table using portable Alembic API
    op.create_table(
        'shared_tasks',
        sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
        sa.Column('user_id', sa.Integer, nullable=False, server_default='0'),
        sa.Column('original_user_id', sa.Integer, nullable=False, server_default='0'),
        sa.Column('original_task_id', sa.Integer, nullable=False, server_default='0'),
        sa.Column('copied_task_id', sa.Integer, nullable=False, server_default='0'),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime, nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.UniqueConstraint('user_id', 'original_task_id', name='uniq_user_original_task'),
    )
    op.create_index('idx_shared_tasks_user_id', 'shared_tasks', ['user_id'])
    op.create_index('idx_shared_tasks_original_user_id', 'shared_tasks', ['original_user_id'])
    op.create_index('idx_shared_tasks_original_task_id', 'shared_tasks', ['original_task_id'])
    op.create_index('idx_shared_tasks_copied_task_id', 'shared_tasks', ['copied_task_id'])

    # 4. Recreate task_members table using portable Alembic API
    op.create_table(
        'task_members',
        sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
        sa.Column('task_id', sa.Integer, nullable=False),
        sa.Column('user_id', sa.Integer, nullable=False),
        sa.Column('invited_by', sa.Integer, nullable=True),
        sa.Column('status', sa.Enum('ACTIVE', 'REMOVED', name='task_member_status'), nullable=False, server_default='ACTIVE'),
        sa.Column('joined_at', sa.DateTime, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.UniqueConstraint('task_id', 'user_id', name='uq_task_members'),
    )
    op.create_index('ix_task_members_task_id', 'task_members', ['task_id'])
    op.create_index('ix_task_members_user_id', 'task_members', ['user_id'])

    # Note: Data is not restored in downgrade. Manual data migration would be needed
    # if rollback is required with data preservation.
