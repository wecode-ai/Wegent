# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add multi-model comparison fields to subtasks

Revision ID: 2a3b4c5d6e7f
Revises: 56b6ed7610fe
Create Date: 2025-01-01 00:00:00.000000

"""
import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "2a3b4c5d6e7f"
down_revision = "56b6ed7610fe"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add multi-model comparison fields to subtasks table
    op.add_column(
        "subtasks",
        sa.Column("model_name", sa.String(256), nullable=True),
    )
    op.add_column(
        "subtasks",
        sa.Column("model_display_name", sa.String(256), nullable=True),
    )
    op.add_column(
        "subtasks",
        sa.Column("compare_group_id", sa.String(64), nullable=True),
    )
    op.add_column(
        "subtasks",
        sa.Column(
            "is_selected_response",
            sa.Boolean(),
            nullable=False,
            server_default="0",
        ),
    )

    # Add index for compare_group_id for efficient querying
    op.create_index(
        "ix_subtasks_compare_group_id",
        "subtasks",
        ["compare_group_id"],
    )


def downgrade() -> None:
    # Remove index
    op.drop_index("ix_subtasks_compare_group_id", table_name="subtasks")

    # Remove columns
    op.drop_column("subtasks", "is_selected_response")
    op.drop_column("subtasks", "compare_group_id")
    op.drop_column("subtasks", "model_display_name")
    op.drop_column("subtasks", "model_name")
