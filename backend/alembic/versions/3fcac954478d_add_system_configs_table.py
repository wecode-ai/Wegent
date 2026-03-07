# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add system_configs table for quick access and other system configurations

Revision ID: 3fcac954478d
Revises: c3d4e5f6a7b8
Create Date: 2025-12-08 10:00:00.000000+08:00

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3fcac954478d"
down_revision: Union[str, Sequence[str], None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create system_configs table for storing system-wide configurations."""
    op.create_table(
        "system_configs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("config_key", sa.String(100), nullable=False),
        sa.Column("config_value", sa.String(4096), nullable=False, server_default="{}"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("config_key"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index("ix_system_configs_config_key", "system_configs", ["config_key"])


def downgrade() -> None:
    """Drop system_configs table."""
    op.drop_index("ix_system_configs_config_key", table_name="system_configs")
    op.drop_table("system_configs")
