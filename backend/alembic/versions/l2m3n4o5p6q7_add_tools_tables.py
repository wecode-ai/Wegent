# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add tools and tool_secrets tables

Revision ID: l2m3n4o5p6q7
Revises: k1l2m3n4o5p6
Create Date: 2025-12-20 10:00:00.000000+08:00

This migration creates:
1. tools table for storing tool definitions (MCP servers and builtin tools)
2. tool_secrets table for storing encrypted sensitive configurations per Ghost
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "l2m3n4o5p6q7"
down_revision: Union[str, None] = "k1l2m3n4o5p6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create tools and tool_secrets tables."""

    # Create tools table
    op.create_table(
        "tools",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("namespace", sa.String(255), nullable=False, server_default="default"),
        sa.Column("type", sa.String(50), nullable=False),  # mcp, builtin
        sa.Column(
            "visibility", sa.String(50), nullable=False, server_default="personal"
        ),  # personal, team, public
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("mcp_config", sa.JSON(), nullable=True),
        sa.Column("builtin_config", sa.JSON(), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Create indexes for tools
    op.create_index("ix_tools_id", "tools", ["id"])
    op.create_index("ix_tools_name", "tools", ["name"])
    op.create_index("idx_tool_user_name", "tools", ["user_id", "name"])
    op.create_index("idx_tool_visibility", "tools", ["visibility"])
    op.create_index("idx_tool_type", "tools", ["type"])

    # Create tool_secrets table
    op.create_table(
        "tool_secrets",
        sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
        sa.Column("ghost_id", sa.Integer(), nullable=False),  # References kinds.id
        sa.Column(
            "tool_id",
            sa.Integer(),
            sa.ForeignKey("tools.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("encrypted_env", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ghost_id", "tool_id", name="uq_ghost_tool_secret"),
    )

    # Create indexes for tool_secrets
    op.create_index("ix_tool_secrets_id", "tool_secrets", ["id"])
    op.create_index("idx_tool_secret_ghost", "tool_secrets", ["ghost_id"])
    op.create_index("idx_tool_secret_tool", "tool_secrets", ["tool_id"])


def downgrade() -> None:
    """Drop tools and tool_secrets tables."""

    # Drop tool_secrets table first (due to foreign key)
    op.drop_index("idx_tool_secret_tool", table_name="tool_secrets")
    op.drop_index("idx_tool_secret_ghost", table_name="tool_secrets")
    op.drop_index("ix_tool_secrets_id", table_name="tool_secrets")
    op.drop_table("tool_secrets")

    # Drop tools table
    op.drop_index("idx_tool_type", table_name="tools")
    op.drop_index("idx_tool_visibility", table_name="tools")
    op.drop_index("idx_tool_user_name", table_name="tools")
    op.drop_index("ix_tools_name", table_name="tools")
    op.drop_index("ix_tools_id", table_name="tools")
    op.drop_table("tools")
