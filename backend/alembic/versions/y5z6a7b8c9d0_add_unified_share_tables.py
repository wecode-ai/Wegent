# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add unified share tables (share_links and resource_members)

Revision ID: y5z6a7b8c9d0
Revises: x4y5z6a7b8c9
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
            "ix_share_links_resource",
            "share_links",
            ["resource_type", "resource_id"],
            unique=False,
        )
        op.create_index(
            "ix_share_links_token", "share_links", ["share_token"], unique=True
        )
        op.create_index(
            "ix_share_links_creator",
            "share_links",
            ["created_by_user_id"],
            unique=False,
        )
        op.create_index(
            "uq_share_links_active_resource",
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
            "ix_resource_members_resource",
            "resource_members",
            ["resource_type", "resource_id"],
            unique=False,
        )
        op.create_index(
            "ix_resource_members_user",
            "resource_members",
            ["user_id"],
            unique=False,
        )
        op.create_index(
            "ix_resource_members_status",
            "resource_members",
            ["status"],
            unique=False,
        )
        op.create_index(
            "ix_resource_members_resource_status",
            "resource_members",
            ["resource_type", "resource_id", "status"],
            unique=False,
        )
        op.create_index(
            "ix_resource_members_share_link",
            "resource_members",
            ["share_link_id"],
            unique=False,
        )


def downgrade() -> None:
    """Drop share_links and resource_members tables."""

    # Drop resource_members indexes and table
    if table_exists("resource_members"):
        op.drop_index("ix_resource_members_share_link", table_name="resource_members")
        op.drop_index(
            "ix_resource_members_resource_status", table_name="resource_members"
        )
        op.drop_index("ix_resource_members_status", table_name="resource_members")
        op.drop_index("ix_resource_members_user", table_name="resource_members")
        op.drop_index("ix_resource_members_resource", table_name="resource_members")
        op.drop_table("resource_members")

    # Drop share_links indexes and table
    if table_exists("share_links"):
        op.drop_index("uq_share_links_active_resource", table_name="share_links")
        op.drop_index("ix_share_links_creator", table_name="share_links")
        op.drop_index("ix_share_links_token", table_name="share_links")
        op.drop_index("ix_share_links_resource", table_name="share_links")
        op.drop_table("share_links")
