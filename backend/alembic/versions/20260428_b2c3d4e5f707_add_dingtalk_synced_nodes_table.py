# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add dingtalk_synced_nodes table

Revision ID: b2c3d4e5f707
Revises: a1b2c3d4e5f6
Create Date: 2026-04-28

Add dingtalk_synced_nodes table for storing DingTalk document
nodes synced from the user's MCP server. Stores document name,
URL, folder hierarchy, and metadata for each synced node.
content_updated_at stores the updateTime from list_nodes response.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "b2c3d4e5f707"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dingtalk_synced_nodes",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("dingtalk_node_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(500), nullable=False),
        sa.Column("doc_url", sa.String(1024), nullable=False),
        sa.Column(
            "parent_node_id",
            sa.String(64),
            nullable=False,
            server_default=sa.text("''"),
        ),
        sa.Column("node_type", sa.String(32), nullable=False),
        sa.Column(
            "workspace_id", sa.String(64), nullable=False, server_default=sa.text("''")
        ),
        sa.Column(
            "content_type", sa.String(32), nullable=False, server_default=sa.text("''")
        ),
        sa.Column("content_updated_at", sa.DateTime(), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")
        ),
        sa.Column("last_synced_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
        comment="DingTalk synced document nodes",
    )
    op.create_index(
        "ix_dingtalk_nodes_user_node",
        "dingtalk_synced_nodes",
        ["user_id", "dingtalk_node_id"],
        unique=True,
    )
    op.create_index(
        "ix_dingtalk_nodes_user_parent",
        "dingtalk_synced_nodes",
        ["user_id", "parent_node_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_dingtalk_synced_nodes_id"),
        "dingtalk_synced_nodes",
        ["id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_dingtalk_synced_nodes_id"), table_name="dingtalk_synced_nodes"
    )
    op.drop_index("ix_dingtalk_nodes_user_parent", table_name="dingtalk_synced_nodes")
    op.drop_index("ix_dingtalk_nodes_user_node", table_name="dingtalk_synced_nodes")
    op.drop_table("dingtalk_synced_nodes")
