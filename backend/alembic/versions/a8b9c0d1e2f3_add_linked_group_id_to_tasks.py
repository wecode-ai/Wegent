# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add linked_group_id to tasks table for performance optimization

Revision ID: a8b9c0d1e2f3
Revises: c9900f078622
Create Date: 2026-03-10 14:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a8b9c0d1e2f3"
down_revision: Union[str, None] = "c9900f078622"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add linked_group_id column and index to tasks table.

    This column stores the namespace_id of the linked group for group chats,
    eliminating the need for slow JSON_EXTRACT queries.
    """
    # Add linked_group_id column with NOT NULL constraint and default value 0
    # linked_group_id = 0 means no linked group (not created from a group)
    op.add_column(
        "tasks",
        sa.Column(
            "linked_group_id",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Linked namespace ID for group chats (0 = not linked)",
        ),
    )

    # Create index for fast lookups
    op.create_index(
        "ix_tasks_linked_group_id",
        "tasks",
        ["linked_group_id"],
        unique=False,
    )

    # Create composite index for common query pattern: find tasks by user with linked group
    op.create_index(
        "ix_tasks_user_id_linked_group_id",
        "tasks",
        ["user_id", "linked_group_id"],
        unique=False,
    )

    # Migrate existing data: extract linked_group from JSON and populate linked_group_id
    # This is a one-time migration that parses JSON and sets the linked_group_id
    conn = op.get_bind()

    # Get all tasks that have linked_group in their JSON
    if conn.dialect.name == "mysql":
        # MySQL: use JSON_EXTRACT to find tasks with linked_group
        result = conn.execute(
            sa.text(
                """
                SELECT id, JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.linked_group')) as linked_group
                FROM tasks
                WHERE JSON_EXTRACT(json, '$.spec.linked_group') IS NOT NULL
                AND kind = 'Task'
            """
            )
        ).fetchall()
    else:
        # SQLite: load all tasks and filter in Python
        result = conn.execute(
            sa.text(
                """
                SELECT id, json
                FROM tasks
                WHERE kind = 'Task'
            """
            )
        ).fetchall()

        # Filter tasks with linked_group in Python for SQLite
        import json

        filtered_result = []
        for row in result:
            try:
                task_json = json.loads(row[1]) if isinstance(row[1], str) else row[1]
                linked_group = task_json.get("spec", {}).get("linked_group")
                if linked_group:
                    filtered_result.append((row[0], linked_group))
            except Exception:
                pass
        result = filtered_result

    # For each task with linked_group, find the namespace_id and update
    for row in result:
        task_id = row[0]
        linked_group_name = row[1]

        if not linked_group_name:
            continue

        # Find namespace_id by name
        namespace_result = conn.execute(
            sa.text("SELECT id FROM namespace WHERE name = :name AND is_active = true"),
            {"name": linked_group_name},
        ).fetchone()

        if namespace_result:
            namespace_id = namespace_result[0]
            # Update the task with the linked_group_id
            conn.execute(
                sa.text(
                    "UPDATE tasks SET linked_group_id = :namespace_id WHERE id = :task_id"
                ),
                {"namespace_id": namespace_id, "task_id": task_id},
            )


def downgrade() -> None:
    """Remove linked_group_id column and indexes."""
    # Drop indexes first
    op.drop_index("ix_tasks_user_id_linked_group_id", table_name="tasks")
    op.drop_index("ix_tasks_linked_group_id", table_name="tasks")

    # Drop column
    op.drop_column("tasks", "linked_group_id")
