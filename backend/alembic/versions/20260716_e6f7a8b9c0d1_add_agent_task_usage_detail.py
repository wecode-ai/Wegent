# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add internal agent task usage detail table.

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
"""

import sqlalchemy as sa

from alembic import op

revision = "e6f7a8b9c0d1"
down_revision = "d5e6f7a8b9c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_task_usage_detail",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("task_id", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column(
            "visitor_user_id", sa.BigInteger(), server_default="0", nullable=False
        ),
        sa.Column("task_name", sa.String(128), server_default="", nullable=False),
        sa.Column("agent_name", sa.String(255), server_default="", nullable=False),
        sa.Column("agent_namespace", sa.String(128), server_default="", nullable=False),
        sa.Column("agent_user_id", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column(
            "task_created_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column("ai_rounds", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "completed_ai_rounds", sa.Integer(), server_default="0", nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", name="uniq_task_id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_agent_time",
        "agent_task_usage_detail",
        ["agent_namespace", "agent_user_id", "agent_name", "task_created_at"],
    )
    op.create_index(
        "idx_time_visitor",
        "agent_task_usage_detail",
        ["task_created_at", "visitor_user_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_time_visitor", table_name="agent_task_usage_detail")
    op.drop_index("idx_agent_time", table_name="agent_task_usage_detail")
    op.drop_table("agent_task_usage_detail")
