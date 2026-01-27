# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add user_pets table for pet nurturing feature

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
    # Create user_pets table
    op.create_table(
        "user_pets",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("pet_name", sa.String(50), nullable=False, server_default="Buddy"),
        sa.Column("stage", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("experience", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_chats", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_memories", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("current_streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("longest_streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_active_date", sa.Date(), nullable=True),
        sa.Column(
            "appearance_traits",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column("svg_seed", sa.String(64), nullable=False, server_default=""),
        sa.Column("is_visible", sa.Boolean(), nullable=False, server_default="1"),
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
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # Create indexes
    op.create_index("ix_user_pets_user_id", "user_pets", ["user_id"], unique=True)


def downgrade() -> None:
    # Drop indexes first
    op.drop_index("ix_user_pets_user_id", table_name="user_pets")
    # Drop table
    op.drop_table("user_pets")
