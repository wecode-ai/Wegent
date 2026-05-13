# SPDX-FileCopyrightText: 2025 ZINFOID_00AQ, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add dingtalk node source column

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a708
Create Date: 2026-05-12

Add source column to dingtalk_synced_nodes table to distinguish between
'docs' (personal documents) and 'workspace' (knowledge base) nodes.
Also replaces the unique index to include source so that the same node ID
can exist in both sources without conflict.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "d4e5f6a7b8c9"
down_revision = "c3d4e5f6a708"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dingtalk_synced_nodes",
        sa.Column("source", sa.String(16), nullable=False, server_default="docs"),
    )
    op.drop_index("ix_dingtalk_nodes_user_node", table_name="dingtalk_synced_nodes")
    op.create_index(
        "ix_dingtalk_nodes_user_node_source",
        "dingtalk_synced_nodes",
        ["user_id", "dingtalk_node_id", "source"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_dingtalk_nodes_user_node_source", table_name="dingtalk_synced_nodes"
    )
    op.create_index(
        "ix_dingtalk_nodes_user_node",
        "dingtalk_synced_nodes",
        ["user_id", "dingtalk_node_id"],
        unique=True,
    )
    op.drop_column("dingtalk_synced_nodes", "source")
