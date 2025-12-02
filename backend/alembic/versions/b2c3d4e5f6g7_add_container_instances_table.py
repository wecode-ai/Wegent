# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add container_instances table for persistent container management

Revision ID: b2c3d4e5f6g7
Revises: 1a2b3c4d5e6f
Create Date: 2025-01-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6g7"
down_revision: Union[str, None] = "1a2b3c4d5e6f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create container_instances table
    op.create_table(
        "container_instances",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("shell_id", sa.BigInteger(), nullable=False),
        sa.Column("container_id", sa.String(length=64), nullable=True),
        sa.Column("access_url", sa.String(length=500), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("repo_url", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("last_task_at", sa.DateTime(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("container_id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    # Create indexes
    op.create_index("idx_user_id", "container_instances", ["user_id"], unique=False)
    op.create_index("idx_shell_id", "container_instances", ["shell_id"], unique=False)
    op.create_index("idx_container_status", "container_instances", ["status"], unique=False)
    op.create_index("idx_user_shell", "container_instances", ["user_id", "shell_id"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_user_shell", table_name="container_instances")
    op.drop_index("idx_container_status", table_name="container_instances")
    op.drop_index("idx_shell_id", table_name="container_instances")
    op.drop_index("idx_user_id", table_name="container_instances")
    op.drop_table("container_instances")
