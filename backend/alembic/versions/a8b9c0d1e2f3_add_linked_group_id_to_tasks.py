# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add linked_group_id to tasks table and task_knowledge_base_bindings table

Revision ID: a8b9c0d1e2f3
Revises: c9900f078622
Create Date: 2026-03-10 14:00:00.000000

This migration includes two performance optimizations:

1. linked_group_id column on tasks table:
   - Stores the namespace_id of the linked group for group chats
   - Eliminates the need for slow JSON_EXTRACT queries on linked_group

2. task_knowledge_base_bindings table:
   - Stores Task-KnowledgeBase relationships
   - Enables efficient indexed queries instead of JSON parsing
   - Performance improvement: O(n) JSON scan -> O(log n) index lookup
"""

import json
from datetime import datetime
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
    """Add linked_group_id column and task_knowledge_base_bindings table."""
    # Part 1: Add linked_group_id column to tasks table
    _upgrade_linked_group_id()

    # Part 2: Create task_knowledge_base_bindings table
    _upgrade_task_kb_bindings()


def _upgrade_linked_group_id() -> None:
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


def _upgrade_task_kb_bindings() -> None:
    """Create task_knowledge_base_bindings table and migrate existing data."""

    # 1. Create the table
    op.create_table(
        "task_knowledge_base_bindings",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("task_id", sa.BigInteger(), nullable=False),
        sa.Column("knowledge_base_id", sa.BigInteger(), nullable=False),
        sa.Column("bound_by", sa.String(255), nullable=False),
        sa.Column("bound_at", sa.DateTime(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        # Foreign keys with cascade delete
        sa.ForeignKeyConstraint(
            ["task_id"],
            ["tasks.id"],
            name="fk_tkb_task_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["knowledge_base_id"],
            ["kinds.id"],
            name="fk_tkb_kb_id",
            ondelete="CASCADE",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # 2. Create indexes
    op.create_index("idx_tkb_task_id", "task_knowledge_base_bindings", ["task_id"])
    op.create_index(
        "idx_tkb_kb_id", "task_knowledge_base_bindings", ["knowledge_base_id"]
    )

    # 3. Create unique constraint to prevent duplicate bindings
    op.create_unique_constraint(
        "uk_task_kb",
        "task_knowledge_base_bindings",
        ["task_id", "knowledge_base_id"],
    )

    # 4. Migrate existing data from JSON to the new table
    _migrate_kb_bindings()


def _migrate_kb_bindings() -> None:
    """Migrate existing knowledgeBaseRefs from JSON to the bindings table.

    This function:
    1. Queries all Tasks with knowledgeBaseRefs in their JSON
    2. Extracts KB bindings with valid IDs
    3. Batch inserts into the new table
    """
    conn = op.get_bind()
    batch_size = 1000
    offset = 0
    total_migrated = 0

    while True:
        # Query tasks with knowledgeBaseRefs
        if conn.dialect.name == "mysql":
            # MySQL: use JSON_LENGTH to filter tasks with KB refs
            result = conn.execute(
                sa.text(
                    """
                    SELECT id, json
                    FROM tasks
                    WHERE kind = 'Task'
                      AND is_active = 1
                      AND JSON_LENGTH(json, '$.spec.knowledgeBaseRefs') > 0
                    LIMIT :limit OFFSET :offset
                """
                ),
                {"limit": batch_size, "offset": offset},
            ).fetchall()
        else:
            # SQLite: load all tasks and filter in Python
            result = conn.execute(
                sa.text(
                    """
                    SELECT id, json
                    FROM tasks
                    WHERE kind = 'Task'
                      AND is_active = 1
                    LIMIT :limit OFFSET :offset
                """
                ),
                {"limit": batch_size, "offset": offset},
            ).fetchall()

        if not result:
            break

        # Collect bindings to insert
        bindings = []
        for row in result:
            task_id = row[0]
            task_json_raw = row[1]

            # Parse JSON
            try:
                if isinstance(task_json_raw, str):
                    task_json = json.loads(task_json_raw)
                elif isinstance(task_json_raw, dict):
                    task_json = task_json_raw
                else:
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            # Extract knowledgeBaseRefs
            spec = task_json.get("spec", {})
            kb_refs = spec.get("knowledgeBaseRefs", []) or []

            for ref in kb_refs:
                kb_id = ref.get("id")
                if kb_id is None:
                    # Skip legacy refs without ID (they need to be migrated first)
                    continue

                bound_by = ref.get("boundBy", "migration")
                bound_at_str = ref.get("boundAt")

                # Parse bound_at timestamp
                if bound_at_str:
                    try:
                        # Handle ISO format with Z suffix
                        if bound_at_str.endswith("Z"):
                            bound_at_str = bound_at_str[:-1]
                        bound_at = datetime.fromisoformat(bound_at_str)
                    except (ValueError, TypeError):
                        bound_at = datetime.utcnow()
                else:
                    bound_at = datetime.utcnow()

                bindings.append(
                    {
                        "task_id": task_id,
                        "knowledge_base_id": kb_id,
                        "bound_by": bound_by,
                        "bound_at": bound_at,
                    }
                )

        # Batch insert with INSERT IGNORE to handle duplicates
        if bindings:
            if conn.dialect.name == "mysql":
                # MySQL: use INSERT IGNORE
                for binding in bindings:
                    try:
                        conn.execute(
                            sa.text(
                                """
                                INSERT IGNORE INTO task_knowledge_base_bindings
                                (task_id, knowledge_base_id, bound_by, bound_at)
                                VALUES (:task_id, :knowledge_base_id, :bound_by, :bound_at)
                            """
                            ),
                            binding,
                        )
                        total_migrated += 1
                    except Exception:
                        # Skip on error (e.g., FK constraint if KB was deleted)
                        pass
            else:
                # SQLite: use INSERT OR IGNORE
                for binding in bindings:
                    try:
                        conn.execute(
                            sa.text(
                                """
                                INSERT OR IGNORE INTO task_knowledge_base_bindings
                                (task_id, knowledge_base_id, bound_by, bound_at)
                                VALUES (:task_id, :knowledge_base_id, :bound_by, :bound_at)
                            """
                            ),
                            binding,
                        )
                        total_migrated += 1
                    except Exception:
                        pass

        offset += batch_size

        # Safety check: if we've processed many batches without finding data, stop
        if offset > 10000000:  # 10 million records safety limit
            break

    print(
        f"Migrated {total_migrated} KB bindings to task_knowledge_base_bindings table"
    )


def downgrade() -> None:
    """Remove linked_group_id column, indexes, and task_knowledge_base_bindings table."""
    # Part 1: Drop task_knowledge_base_bindings table
    op.drop_constraint("uk_task_kb", "task_knowledge_base_bindings", type_="unique")
    op.drop_index("idx_tkb_kb_id", table_name="task_knowledge_base_bindings")
    op.drop_index("idx_tkb_task_id", table_name="task_knowledge_base_bindings")
    op.drop_table("task_knowledge_base_bindings")

    # Part 2: Drop linked_group_id column and indexes
    op.drop_index("ix_tasks_user_id_linked_group_id", table_name="tasks")
    op.drop_index("ix_tasks_linked_group_id", table_name="tasks")
    op.drop_column("tasks", "linked_group_id")
