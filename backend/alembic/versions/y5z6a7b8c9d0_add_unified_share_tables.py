# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add unified share tables (share_links and resource_members)

Revision ID: y5z6a7b8c9d0
Revises: w3x4y5z6a7b8
Create Date: 2025-02-02

This migration adds two unified tables for resource sharing:
1. share_links - Store share link configurations and tokens
2. resource_members - Store user access permissions to shared resources

These tables replace the following fragmented tables:
- shared_teams
- shared_tasks
- task_members

Supported resource types: Team, Task, KnowledgeBase
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "y5z6a7b8c9d0"
down_revision: Union[str, None] = "w3x4y5z6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def table_exists(table_name: str) -> bool:
    """Check if a table exists in the database."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_name = :table_name AND table_schema = DATABASE()"
        ),
        {"table_name": table_name},
    )
    return result.scalar() > 0


def upgrade() -> None:
    """Create share_links and resource_members tables."""

    # Create share_links table
    if not table_exists("share_links"):
        op.create_table(
            "share_links",
            sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
            # Resource identification (polymorphic association)
            sa.Column(
                "resource_type",
                sa.String(50),
                nullable=False,
                comment="Resource type: Team, Task, KnowledgeBase",
            ),
            sa.Column(
                "resource_id",
                sa.Integer(),
                nullable=False,
                comment="Resource ID (kinds.id or tasks.id)",
            ),
            # Share link info
            sa.Column(
                "share_token",
                sa.String(512),
                nullable=False,
                comment="AES encrypted share token",
            ),
            # Share configuration
            sa.Column(
                "require_approval",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("1"),
                comment="Whether joining requires approval",
            ),
            sa.Column(
                "default_permission_level",
                sa.String(20),
                nullable=False,
                server_default="view",
                comment="Default permission level: view, edit, manage",
            ),
            # Expiration
            sa.Column(
                "expires_at",
                sa.DateTime(),
                nullable=True,
                comment="Expiration time (NULL = never expires)",
            ),
            # Creator info
            sa.Column(
                "created_by_user_id",
                sa.Integer(),
                nullable=False,
                comment="User who created the share link",
            ),
            # Status
            sa.Column(
                "is_active",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("1"),
                comment="Whether the link is active",
            ),
            # Timestamps
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
                onupdate=sa.func.now(),
            ),
            sa.PrimaryKeyConstraint("id"),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
            comment="Share link configurations for resources",
        )

        # Create indexes for share_links
        op.create_index(
            "idx_share_links_token", "share_links", ["share_token"], unique=True
        )
        op.create_index(
            "idx_share_links_creator",
            "share_links",
            ["created_by_user_id"],
            unique=False,
        )
        op.create_index(
            "idx_share_links_active_resource",
            "share_links",
            ["resource_type", "resource_id", "is_active"],
            unique=False,
        )

    # Create resource_members table
    if not table_exists("resource_members"):
        op.create_table(
            "resource_members",
            sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
            # Resource identification (polymorphic association)
            sa.Column(
                "resource_type",
                sa.String(50),
                nullable=False,
                comment="Resource type: Team, Task, KnowledgeBase",
            ),
            sa.Column(
                "resource_id",
                sa.Integer(),
                nullable=False,
                comment="Resource ID",
            ),
            # Member info
            sa.Column(
                "user_id",
                sa.Integer(),
                nullable=False,
                comment="Member user ID",
            ),
            # Permission level
            sa.Column(
                "permission_level",
                sa.String(20),
                nullable=False,
                server_default="view",
                comment="Permission level: view, edit, manage",
            ),
            # Status
            sa.Column(
                "status",
                sa.String(20),
                nullable=False,
                server_default="pending",
                comment="Status: pending, approved, rejected",
            ),
            # Source info
            sa.Column(
                "invited_by_user_id",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
                comment="Inviter user ID (0 = via link)",
            ),
            sa.Column(
                "share_link_id",
                sa.Integer(),
                nullable=True,
                comment="Associated share link ID (when joined via link)",
            ),
            # Review info
            sa.Column(
                "reviewed_by_user_id",
                sa.Integer(),
                nullable=True,
                comment="Reviewer user ID",
            ),
            sa.Column(
                "reviewed_at",
                sa.DateTime(),
                nullable=True,
                comment="Review timestamp",
            ),
            # Task-specific field (only for Task type)
            sa.Column(
                "copied_resource_id",
                sa.Integer(),
                nullable=True,
                comment="Copied resource ID (for Task copy behavior)",
            ),
            # Timestamps
            sa.Column(
                "requested_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
                comment="Request timestamp",
            ),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
                onupdate=sa.func.now(),
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "resource_type",
                "resource_id",
                "user_id",
                name="uq_resource_members",
            ),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
            comment="Resource member permissions and access control",
        )

        # Create indexes for resource_members
        op.create_index(
            "idx_resource_members_user",
            "resource_members",
            ["user_id"],
            unique=False,
        )
        op.create_index(
            "idx_resource_members_status",
            "resource_members",
            ["status"],
            unique=False,
        )
        op.create_index(
            "idx_resource_members_resource_status",
            "resource_members",
            ["resource_type", "resource_id", "status"],
            unique=False,
        )
        op.create_index(
            "idx_resource_members_share_link",
            "resource_members",
            ["share_link_id"],
            unique=False,
        )

    # Migrate data from old tables to new unified tables
    migrate_data_from_old_tables()


def migrate_data_from_old_tables() -> None:
    """Migrate data from shared_teams, shared_tasks, and task_members to new tables."""
    conn = op.get_bind()

    # Migrate shared_teams -> share_links + resource_members
    if table_exists("shared_teams"):
        # Create share_links for each unique team_id in shared_teams
        conn.execute(
            sa.text(
                """
                INSERT INTO share_links (
                    resource_type, resource_id, share_token,
                    require_approval, default_permission_level, expires_at,
                    created_by_user_id, is_active, created_at, updated_at
                )
                SELECT DISTINCT
                    'Team' as resource_type,
                    team_id as resource_id,
                    CONCAT('team_', team_id, '_', MD5(CONCAT(team_id, NOW()))) as share_token,
                    0 as require_approval,
                    'view' as default_permission_level,
                    DATE_ADD(NOW(), INTERVAL 100 YEAR) as expires_at,
                    original_user_id as created_by_user_id,
                    is_active,
                    created_at,
                    updated_at
                FROM shared_teams
                WHERE team_id NOT IN (
                    SELECT resource_id FROM share_links
                    WHERE resource_type = 'Team'
                )
            """
            )
        )

        # Create resource_members for each shared_teams entry
        conn.execute(
            sa.text(
                """
                INSERT INTO resource_members (
                    resource_type, resource_id, user_id,
                    permission_level, status, invited_by_user_id,
                    share_link_id, requested_at, created_at, updated_at
                )
                SELECT
                    'Team' as resource_type,
                    st.team_id as resource_id,
                    st.user_id,
                    'view' as permission_level,
                    CASE WHEN st.is_active = 1 THEN 'approved' ELSE 'rejected' END as status,
                    st.original_user_id as invited_by_user_id,
                    (SELECT id FROM share_links
                     WHERE resource_type = 'Team' AND resource_id = st.team_id
                     LIMIT 1) as share_link_id,
                    st.created_at as requested_at,
                    st.created_at,
                    st.updated_at
                FROM shared_teams st
                WHERE NOT EXISTS (
                    SELECT 1 FROM resource_members rm
                    WHERE rm.resource_type = 'Team'
                    AND rm.resource_id = st.team_id
                    AND rm.user_id = st.user_id
                )
            """
            )
        )

    # Migrate shared_tasks -> share_links + resource_members
    if table_exists("shared_tasks"):
        # Create share_links for each unique original_task_id in shared_tasks
        conn.execute(
            sa.text(
                """
                INSERT INTO share_links (
                    resource_type, resource_id, share_token,
                    require_approval, default_permission_level, expires_at,
                    created_by_user_id, is_active, created_at, updated_at
                )
                SELECT DISTINCT
                    'Task' as resource_type,
                    original_task_id as resource_id,
                    CONCAT('task_', original_task_id, '_', MD5(CONCAT(original_task_id, NOW()))) as share_token,
                    0 as require_approval,
                    'view' as default_permission_level,
                    DATE_ADD(NOW(), INTERVAL 100 YEAR) as expires_at,
                    original_user_id as created_by_user_id,
                    is_active,
                    created_at,
                    updated_at
                FROM shared_tasks
                WHERE original_task_id NOT IN (
                    SELECT resource_id FROM share_links
                    WHERE resource_type = 'Task'
                )
            """
            )
        )

        # Create resource_members for each shared_tasks entry
        conn.execute(
            sa.text(
                """
                INSERT INTO resource_members (
                    resource_type, resource_id, user_id,
                    permission_level, status, invited_by_user_id,
                    share_link_id, copied_resource_id,
                    requested_at, created_at, updated_at
                )
                SELECT
                    'Task' as resource_type,
                    st.original_task_id as resource_id,
                    st.user_id,
                    'view' as permission_level,
                    CASE WHEN st.is_active = 1 THEN 'approved' ELSE 'rejected' END as status,
                    st.original_user_id as invited_by_user_id,
                    (SELECT id FROM share_links
                     WHERE resource_type = 'Task' AND resource_id = st.original_task_id
                     LIMIT 1) as share_link_id,
                    st.copied_task_id as copied_resource_id,
                    st.created_at as requested_at,
                    st.created_at,
                    st.updated_at
                FROM shared_tasks st
                WHERE NOT EXISTS (
                    SELECT 1 FROM resource_members rm
                    WHERE rm.resource_type = 'Task'
                    AND rm.resource_id = st.original_task_id
                    AND rm.user_id = st.user_id
                )
            """
            )
        )

    # Migrate task_members -> resource_members
    if table_exists("task_members"):
        # Create share_links for each unique task_id in task_members
        conn.execute(
            sa.text(
                """
                INSERT INTO share_links (
                    resource_type, resource_id, share_token,
                    require_approval, default_permission_level, expires_at,
                    created_by_user_id, is_active, created_at, updated_at
                )
                SELECT DISTINCT
                    'Task' as resource_type,
                    tm.task_id as resource_id,
                    CONCAT('task_', tm.task_id, '_', MD5(CONCAT(tm.task_id, NOW()))) as share_token,
                    0 as require_approval,
                    'view' as default_permission_level,
                    DATE_ADD(NOW(), INTERVAL 100 YEAR) as expires_at,
                    tm.invited_by as created_by_user_id,
                    CASE WHEN tm.status = 'ACTIVE' THEN 1 ELSE 0 END as is_active,
                    tm.created_at,
                    tm.updated_at
                FROM task_members tm
                WHERE tm.task_id NOT IN (
                    SELECT resource_id FROM share_links
                    WHERE resource_type = 'Task'
                )
            """
            )
        )

        # Create resource_members for each task_members entry
        conn.execute(
            sa.text(
                """
                INSERT INTO resource_members (
                    resource_type, resource_id, user_id,
                    permission_level, status, invited_by_user_id,
                    share_link_id, requested_at, created_at, updated_at
                )
                SELECT
                    'Task' as resource_type,
                    tm.task_id as resource_id,
                    tm.user_id,
                    'view' as permission_level,
                    CASE WHEN tm.status = 'ACTIVE' THEN 'approved' ELSE 'rejected' END as status,
                    tm.invited_by as invited_by_user_id,
                    (SELECT id FROM share_links
                     WHERE resource_type = 'Task' AND resource_id = tm.task_id
                     LIMIT 1) as share_link_id,
                    tm.joined_at as requested_at,
                    tm.created_at,
                    tm.updated_at
                FROM task_members tm
                WHERE NOT EXISTS (
                    SELECT 1 FROM resource_members rm
                    WHERE rm.resource_type = 'Task'
                    AND rm.resource_id = tm.task_id
                    AND rm.user_id = tm.user_id
                )
            """
            )
        )


def downgrade() -> None:
    """Drop share_links and resource_members tables and restore old tables data."""

    # Restore data from new tables to old tables before dropping
    restore_data_to_old_tables()

    # Drop resource_members indexes and table
    if table_exists("resource_members"):
        op.drop_index("idx_resource_members_share_link", table_name="resource_members")
        op.drop_index(
            "idx_resource_members_resource_status", table_name="resource_members"
        )
        op.drop_index("idx_resource_members_status", table_name="resource_members")
        op.drop_index("idx_resource_members_user", table_name="resource_members")
        op.drop_table("resource_members")

    # Drop share_links indexes and table
    if table_exists("share_links"):
        op.drop_index("idx_share_links_active_resource", table_name="share_links")
        op.drop_index("idx_share_links_creator", table_name="share_links")
        op.drop_index("idx_share_links_token", table_name="share_links")
        op.drop_table("share_links")


def restore_data_to_old_tables() -> None:
    """Restore data from share_links and resource_members to old tables."""
    conn = op.get_bind()

    # Restore shared_teams from resource_members (Team type)
    if table_exists("shared_teams") and table_exists("resource_members"):
        conn.execute(
            sa.text(
                """
                INSERT INTO shared_teams (
                    user_id, original_user_id, team_id, is_active, created_at, updated_at
                )
                SELECT DISTINCT
                    rm.user_id,
                    rm.invited_by_user_id as original_user_id,
                    rm.resource_id as team_id,
                    CASE WHEN rm.status = 'approved' THEN 1 ELSE 0 END as is_active,
                    rm.created_at,
                    rm.updated_at
                FROM resource_members rm
                WHERE rm.resource_type = 'Team'
                AND NOT EXISTS (
                    SELECT 1 FROM shared_teams st
                    WHERE st.user_id = rm.user_id
                    AND st.team_id = rm.resource_id
                )
            """
            )
        )

    # Restore shared_tasks from resource_members (Task type with copied_resource_id)
    if table_exists("shared_tasks") and table_exists("resource_members"):
        conn.execute(
            sa.text(
                """
                INSERT INTO shared_tasks (
                    user_id, original_user_id, original_task_id, copied_task_id,
                    is_active, created_at, updated_at
                )
                SELECT DISTINCT
                    rm.user_id,
                    rm.invited_by_user_id as original_user_id,
                    rm.resource_id as original_task_id,
                    rm.copied_resource_id as copied_task_id,
                    CASE WHEN rm.status = 'approved' THEN 1 ELSE 0 END as is_active,
                    rm.created_at,
                    rm.updated_at
                FROM resource_members rm
                WHERE rm.resource_type = 'Task'
                AND rm.copied_resource_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM shared_tasks st
                    WHERE st.user_id = rm.user_id
                    AND st.original_task_id = rm.resource_id
                )
            """
            )
        )

    # Restore task_members from resource_members (Task type without copied_resource_id)
    if table_exists("task_members") and table_exists("resource_members"):
        conn.execute(
            sa.text(
                """
                INSERT INTO task_members (
                    task_id, user_id, invited_by, status, joined_at, created_at, updated_at
                )
                SELECT DISTINCT
                    rm.resource_id as task_id,
                    rm.user_id,
                    rm.invited_by_user_id as invited_by,
                    CASE WHEN rm.status = 'approved' THEN 'ACTIVE' ELSE 'REMOVED' END as status,
                    rm.requested_at as joined_at,
                    rm.created_at,
                    rm.updated_at
                FROM resource_members rm
                WHERE rm.resource_type = 'Task'
                AND rm.copied_resource_id IS NULL
                AND NOT EXISTS (
                    SELECT 1 FROM task_members tm
                    WHERE tm.task_id = rm.resource_id
                    AND tm.user_id = rm.user_id
                )
            """
            )
        )
