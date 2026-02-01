# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add knowledge_base_permissions table

Revision ID: x4y5z6a7b8c9
Revises: w3x4y5z6a7b8
Create Date: 2025-02-01

This migration adds a knowledge_base_permissions table for storing
permission requests and approvals for knowledge base sharing.

The table serves dual purpose:
1. Store pending permission requests from users
2. Store approved permissions for access control
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "x4y5z6a7b8c9"
down_revision: Union[str, None] = "w3x4y5z6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def table_exists(table_name: str) -> bool:
    """Check if a table exists in the database."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_name = :table_name"
        ),
        {"table_name": table_name},
    )
    return result.scalar() > 0


def upgrade() -> None:
    """Create knowledge_base_permissions table."""

    # Check if table already exists
    if table_exists("knowledge_base_permissions"):
        return

    op.create_table(
        "knowledge_base_permissions",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        sa.Column("knowledge_base_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "permission_level",
            sa.Enum("view", "edit", "manage", name="permissionlevel"),
            nullable=False,
            server_default="view",
        ),
        sa.Column(
            "status",
            sa.Enum("pending", "approved", "rejected", name="permissionstatus"),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "requested_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("reviewed_at", sa.DateTime(), nullable=True),
        sa.Column("reviewed_by", sa.Integer(), nullable=True),
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
            "knowledge_base_id", "user_id", name="uq_kb_permissions_kb_user"
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        comment="Knowledge base permission requests and assignments",
    )

    # Create indexes
    op.create_index(
        "ix_knowledge_base_permissions_id",
        "knowledge_base_permissions",
        ["id"],
        unique=False,
    )
    op.create_index(
        "ix_knowledge_base_permissions_knowledge_base_id",
        "knowledge_base_permissions",
        ["knowledge_base_id"],
        unique=False,
    )
    op.create_index(
        "ix_knowledge_base_permissions_user_id",
        "knowledge_base_permissions",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        "ix_kb_permissions_kb_status",
        "knowledge_base_permissions",
        ["knowledge_base_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    """Drop knowledge_base_permissions table."""

    # Drop indexes first
    op.drop_index(
        "ix_kb_permissions_kb_status", table_name="knowledge_base_permissions"
    )
    op.drop_index(
        "ix_knowledge_base_permissions_user_id",
        table_name="knowledge_base_permissions",
    )
    op.drop_index(
        "ix_knowledge_base_permissions_knowledge_base_id",
        table_name="knowledge_base_permissions",
    )
    op.drop_index(
        "ix_knowledge_base_permissions_id", table_name="knowledge_base_permissions"
    )

    # Drop table
    op.drop_table("knowledge_base_permissions")

    # Drop enums (only needed for PostgreSQL, not MySQL)
    # op.execute("DROP TYPE IF EXISTS permissionstatus")
    # op.execute("DROP TYPE IF EXISTS permissionlevel")
