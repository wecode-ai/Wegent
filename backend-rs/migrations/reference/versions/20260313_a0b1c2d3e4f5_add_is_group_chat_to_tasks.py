# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add_is_group_chat_to_tasks

Revision ID: a0b1c2d3e4f5
Revises: c9900f078622
Create Date: 2026-03-14

Add is_group_chat column to tasks table and sync data from JSON field.
This optimization eliminates the need for JSON_EXTRACT in queries,
significantly improving query performance for group chat filtering.
"""

import sqlalchemy as sa

from alembic import op

revision = "a0b1c2d3e4f5"
down_revision = "c9900f078622"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Check if column already exists (for production compatibility)
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col["name"] for col in inspector.get_columns("tasks")]

    if "is_group_chat" not in columns:
        # Step 1: Add is_group_chat column
        op.add_column(
            "tasks",
            sa.Column(
                "is_group_chat",
                sa.Boolean(),
                nullable=False,
                server_default="0",
                comment="Whether this task is a group chat (0 = false, 1 = true)",
            ),
        )

        # Step 2: Sync existing data from JSON field
        # Use dialect-specific JSON extraction
        dialect = conn.dialect.name
        if dialect == "mysql":
            op.execute(
                """
                UPDATE tasks 
                SET is_group_chat = 1 
                WHERE JSON_EXTRACT(json, '$.spec.is_group_chat') = true
            """
            )
        elif dialect == "sqlite":
            op.execute(
                """
                UPDATE tasks 
                SET is_group_chat = 1 
                WHERE json_extract(json, '$.spec.is_group_chat') = 1
            """
            )

        # Step 3: Add index for better query performance
        op.create_index("idx_tasks_is_group_chat", "tasks", ["is_group_chat"])


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col["name"] for col in inspector.get_columns("tasks")]

    if "is_group_chat" in columns:
        op.drop_index("idx_tasks_is_group_chat", table_name="tasks")
        op.drop_column("tasks", "is_group_chat")
