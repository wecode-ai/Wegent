# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add permissions table for knowledge base sharing

Revision ID: w3x4y5z6a7b8
Revises: v2w3x4y5z6a7
Create Date: 2025-01-27

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "w3x4y5z6a7b8"
down_revision: Union[str, None] = "v2w3x4y5z6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create permissions table
    op.create_table(
        "permissions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind_id", sa.Integer(), nullable=False),
        sa.Column(
            "resource_type", sa.String(50), nullable=False, server_default="knowledge_base"
        ),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("permission_type", sa.String(20), nullable=False),
        sa.Column("granted_by_user_id", sa.Integer(), nullable=False),
        sa.Column("granted_at", sa.DateTime(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
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
            "kind_id", "resource_type", "user_id", name="uq_permission_user_resource"
        ),
        comment="Permission authorization table for resource access control",
    )

    # Create indexes
    op.create_index("ix_permissions_kind_id", "permissions", ["kind_id"])
    op.create_index("ix_permissions_user_id", "permissions", ["user_id"])
    op.create_index("ix_permissions_kb_active", "permissions", ["kind_id", "is_active"])


def downgrade() -> None:
    # Drop indexes
    op.drop_index("ix_permissions_kb_active", table_name="permissions")
    op.drop_index("ix_permissions_user_id", table_name="permissions")
    op.drop_index("ix_permissions_kind_id", table_name="permissions")

    # Drop table
    op.drop_table("permissions")
