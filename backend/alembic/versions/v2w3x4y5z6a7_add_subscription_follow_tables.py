# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add subscription follow tables

Revision ID: v2w3x4y5z6a7
Revises: u1v2w3x4y5z6
Create Date: 2025-01-20

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "v2w3x4y5z6a7"
down_revision: Union[str, None] = "u1v2w3x4y5z6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create subscription_follows table
    op.create_table(
        "subscription_follows",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("subscription_id", sa.Integer(), nullable=False),
        sa.Column("follower_user_id", sa.Integer(), nullable=False),
        sa.Column("follow_type", sa.String(20), nullable=False),
        sa.Column("invited_by_user_id", sa.Integer(), nullable=False),
        sa.Column("invitation_status", sa.String(20), nullable=False),
        sa.Column("invited_at", sa.DateTime(), nullable=False),
        sa.Column("responded_at", sa.DateTime(), nullable=False),
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
    )

    # Create indexes for subscription_follows
    op.create_index(
        "ix_sub_follow_subscription", "subscription_follows", ["subscription_id"]
    )
    op.create_index(
        "ix_sub_follow_follower", "subscription_follows", ["follower_user_id"]
    )
    op.create_index(
        "ix_sub_follow_unique",
        "subscription_follows",
        ["subscription_id", "follower_user_id"],
        unique=True,
    )
    op.create_index(
        "ix_sub_follow_pending_invitations",
        "subscription_follows",
        ["follower_user_id", "invitation_status"],
    )

    # Create subscription_share_namespaces table
    op.create_table(
        "subscription_share_namespaces",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("subscription_id", sa.Integer(), nullable=False),
        sa.Column("namespace_id", sa.Integer(), nullable=False),
        sa.Column("shared_by_user_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # Create indexes for subscription_share_namespaces
    op.create_index(
        "ix_sub_share_ns_subscription",
        "subscription_share_namespaces",
        ["subscription_id"],
    )
    op.create_index(
        "ix_sub_share_ns_namespace", "subscription_share_namespaces", ["namespace_id"]
    )
    op.create_index(
        "ix_sub_share_ns_unique",
        "subscription_share_namespaces",
        ["subscription_id", "namespace_id"],
        unique=True,
    )


def downgrade() -> None:
    # Drop subscription_share_namespaces table and indexes
    op.drop_index("ix_sub_share_ns_unique", table_name="subscription_share_namespaces")
    op.drop_index(
        "ix_sub_share_ns_namespace", table_name="subscription_share_namespaces"
    )
    op.drop_index(
        "ix_sub_share_ns_subscription", table_name="subscription_share_namespaces"
    )
    op.drop_table("subscription_share_namespaces")

    # Drop subscription_follows table and indexes
    op.drop_index(
        "ix_sub_follow_pending_invitations", table_name="subscription_follows"
    )
    op.drop_index("ix_sub_follow_unique", table_name="subscription_follows")
    op.drop_index("ix_sub_follow_follower", table_name="subscription_follows")
    op.drop_index("ix_sub_follow_subscription", table_name="subscription_follows")
    op.drop_table("subscription_follows")
