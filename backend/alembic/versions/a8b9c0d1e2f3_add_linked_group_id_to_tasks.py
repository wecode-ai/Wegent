# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add linked_group_id to tasks table and task_knowledge_base_bindings table

Revision ID: a8b9c0d1e2f3
Revises: c9900f078622
Create Date: 2026-03-10 14:00:00.000000

This migration includes performance optimizations:

1. linked_group_id column on tasks table:
   - Stores the namespace_id of the linked group for group chats
   - Eliminates the need for slow JSON_EXTRACT queries on linked_group

2. is_group_chat column on tasks table:
   - Boolean flag to quickly identify group chat tasks
   - Enables efficient indexed queries for group chat list loading
   - Performance improvement: O(n) JSON scan -> O(log n) index lookup

3. task_knowledge_base_bindings table:
   - Stores Task-KnowledgeBase relationships
   - Enables efficient indexed queries instead of JSON parsing

4. Composite indexes for optimized queries
"""

import json
import logging
from datetime import datetime
from typing import Optional, Sequence, Union

import sqlalchemy as sa

from alembic import op

logger = logging.getLogger(__name__)


# revision identifiers, used by Alembic.
revision: str = "a8b9c0d1e2f3"
down_revision: Union[str, None] = "c9900f078622"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add linked_group_id column and task_knowledge_base_bindings table."""
    # Part 1: Add linked_group_id column to tasks table
    _upgrade_linked_group_id()

    # Part 2: Add is_group_chat column to tasks table
    _upgrade_is_group_chat()

    # Part 3: Create task_knowledge_base_bindings table
    _upgrade_task_kb_bindings()

    # Part 4: Create composite indexes for KB binding query optimization
    _upgrade_tasks_composite_index()
    _upgrade_resource_members_composite_index()


def _upgrade_tasks_composite_index() -> None:
    """Add composite index on tasks table for optimized KB binding queries.

    This index optimizes the _get_bound_kb_ids_for_user query which filters by:
    - user_id = <user_id>
    - kind = 'Task'
    - is_active = True
    """
    op.create_index(
        "idx_tasks_user_kind_active",
        "tasks",
        ["user_id", "kind", "is_active"],
        mysql_length={"kind": 50},
    )


def _upgrade_resource_members_composite_index() -> None:
    """Add composite index on resource_members table for optimized KB binding queries.

    This index optimizes the _get_kb_binding_member_role query which filters by:
    - user_id = <user_id>
    - resource_type = 'Task'
    - status = 'approved'
    """
    op.create_index(
        "idx_resource_members_user_type_status",
        "resource_members",
        ["user_id", "resource_type", "status"],
        mysql_length={"resource_type": 50, "status": 20},
    )


def _upgrade_is_group_chat() -> None:
    """Add is_group_chat column and index to tasks table.

    This column stores a boolean flag indicating if the task is a group chat,
    enabling efficient indexed queries for group chat list loading without
    parsing JSON.
    """
    # Add is_group_chat column with NOT NULL constraint and default value False
    op.add_column(
        "tasks",
        sa.Column(
            "is_group_chat",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Whether this task is a group chat (0 = false, 1 = true)",
        ),
    )

    # Create index for fast group chat lookups
    op.create_index(
        "ix_tasks_is_group_chat",
        "tasks",
        ["is_group_chat"],
        unique=False,
    )

    # Create composite index for user group chat queries with pagination
    op.create_index(
        "ix_tasks_user_is_group_chat_updated",
        "tasks",
        ["user_id", "is_group_chat", "updated_at"],
        unique=False,
    )

    # Migrate existing data: extract is_group_chat from JSON
    conn = op.get_bind()

    # Get all tasks that have is_group_chat=true in their JSON
    if conn.dialect.name == "mysql":
        # MySQL: use JSON_EXTRACT to find tasks with is_group_chat=true
        conn.execute(
            sa.text(
                """
                UPDATE tasks
                SET is_group_chat = TRUE
                WHERE kind = 'Task'
                AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.is_group_chat')) = 'true'
            """
            )
        )
    else:
        # SQLite: load all tasks and update in Python
        result = conn.execute(
            sa.text(
                """
                SELECT id, json
                FROM tasks
                WHERE kind = 'Task'
            """
            )
        ).fetchall()

        # Update tasks with is_group_chat=true in Python for SQLite
        for row in result:
            task_id = row[0]
            try:
                task_json = json.loads(row[1]) if isinstance(row[1], str) else row[1]
                is_group_chat = task_json.get("spec", {}).get("is_group_chat")
                if is_group_chat is True:
                    conn.execute(
                        sa.text(
                            "UPDATE tasks SET is_group_chat = 1 WHERE id = :task_id"
                        ),
                        {"task_id": task_id},
                    )
            except Exception as e:
                logger.warning(f"Failed to parse JSON for task id={task_id}: {e}")


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

    # Get all tasks that have linked_group in their JSON AND is_group_chat is true
    if conn.dialect.name == "mysql":
        # MySQL: use JSON_EXTRACT to find tasks with linked_group and is_group_chat=true
        result = conn.execute(
            sa.text(
                """
                SELECT id, JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.linked_group')) as linked_group
                FROM tasks
                WHERE JSON_EXTRACT(json, '$.spec.linked_group') IS NOT NULL
                AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.is_group_chat')) = 'true'
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

        # Filter tasks with linked_group and is_group_chat=true in Python for SQLite
        filtered_result = []
        for row in result:
            task_id = row[0]
            try:
                task_json = json.loads(row[1]) if isinstance(row[1], str) else row[1]
                linked_group = task_json.get("spec", {}).get("linked_group")
                is_group_chat = task_json.get("spec", {}).get("is_group_chat")
                # Only include tasks with both linked_group and is_group_chat=true
                if linked_group and is_group_chat is True:
                    filtered_result.append((task_id, linked_group))
            except Exception as e:
                # Log warning with task ID for malformed JSON
                logger.warning(f"Failed to parse JSON for task id={task_id}: {e}")
        result = filtered_result

    # For each task with linked_group, find the namespace_id and update
    for row in result:
        task_id = row[0]
        linked_group_name = row[1]

        if not linked_group_name:
            continue

        # Find namespace_id by name
        # Use dialect-compatible boolean: SQLite uses 1, MySQL/PostgreSQL support true
        if conn.dialect.name == "mysql":
            namespace_result = conn.execute(
                sa.text(
                    "SELECT id FROM namespace WHERE name = :name AND is_active = true"
                ),
                {"name": linked_group_name},
            ).fetchone()
        else:
            namespace_result = conn.execute(
                sa.text(
                    "SELECT id FROM namespace WHERE name = :name AND is_active = 1"
                ),
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
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("knowledge_base_id", sa.Integer(), nullable=False),
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


def _resolve_kb_by_name(
    conn, kb_name: str, kb_namespace: str, task_id: int, user_id: int
) -> Optional[int]:
    """Resolve knowledge base ID by name, namespace, and user_id.

    This function queries the kinds table to find a knowledge base
    matching the given display name (spec.name), namespace, and user_id.

    Args:
        conn: Database connection
        kb_name: Knowledge base display name (spec.name)
        kb_namespace: Knowledge base namespace
        task_id: Task ID for logging purposes
        user_id: Task owner user_id for filtering KBs by owner

    Returns:
        Knowledge base Kind.id if found and unambiguous, None otherwise
    """
    if not kb_name:
        return None

    # Query all active KnowledgeBase kinds in the namespace for the specific user
    if conn.dialect.name == "mysql":
        kb_result = conn.execute(
            sa.text(
                """
                SELECT id, json
                FROM kinds
                WHERE kind = 'KnowledgeBase'
                  AND namespace = :namespace
                  AND user_id = :user_id
                  AND is_active = true
            """
            ),
            {"namespace": kb_namespace, "user_id": user_id},
        ).fetchall()
    else:
        kb_result = conn.execute(
            sa.text(
                """
                SELECT id, json
                FROM kinds
                WHERE kind = 'KnowledgeBase'
                  AND namespace = :namespace
                  AND user_id = :user_id
                  AND is_active = 1
            """
            ),
            {"namespace": kb_namespace, "user_id": user_id},
        ).fetchall()

    # Filter by matching display name in spec
    matching_kbs = []
    for kb_row in kb_result:
        kb_id = kb_row[0]
        kb_json_raw = kb_row[1]

        try:
            if isinstance(kb_json_raw, str):
                kb_json = json.loads(kb_json_raw)
            elif isinstance(kb_json_raw, dict):
                kb_json = kb_json_raw
            else:
                continue

            kb_spec = kb_json.get("spec", {})
            display_name = kb_spec.get("name")
            if display_name == kb_name:
                matching_kbs.append(kb_id)
        except (json.JSONDecodeError, TypeError):
            continue

    if len(matching_kbs) == 1:
        # Single unambiguous match
        return matching_kbs[0]
    elif len(matching_kbs) > 1:
        # Multiple matches - log warning and skip
        logger.warning(
            f"Ambiguous knowledge base name '{kb_name}' in namespace '{kb_namespace}' "
            f"for user {user_id} and task {task_id}: found {len(matching_kbs)} matches. Skipping binding."
        )
        return None
    else:
        # No match found
        logger.warning(
            f"Knowledge base '{kb_name}' not found in namespace '{kb_namespace}' "
            f"for user {user_id} and task {task_id}"
        )
        return None


def _migrate_kb_bindings() -> None:
    """Migrate existing knowledgeBaseRefs from JSON to the bindings table.

    This function:
    1. Queries all Tasks with knowledgeBaseRefs in their JSON
    2. Extracts KB bindings with valid IDs
    3. For legacy refs without ID, resolves KB by name
    4. Batch inserts into the new table
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
                    SELECT id, json, user_id
                    FROM tasks
                    WHERE kind = 'Task'
                      AND is_active = 1
                      AND JSON_LENGTH(json, '$.spec.knowledgeBaseRefs') > 0
                    ORDER BY id
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
                    SELECT id, json, user_id
                    FROM tasks
                    WHERE kind = 'Task'
                      AND is_active = 1
                    ORDER BY id
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
            task_user_id = row[2]

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

                # If no ID, try to resolve by name (legacy data)
                if kb_id is None:
                    kb_name = ref.get("name") or ref.get("knowledgeBaseName")
                    kb_namespace = ref.get("namespace", "default")

                    if not kb_name:
                        # Skip if no name available to resolve
                        logger.warning(
                            f"Skipping KB ref without id or name for task {task_id}"
                        )
                        continue

                    # Resolve KB by name
                    kb_id = _resolve_kb_by_name(
                        conn, kb_name, kb_namespace, task_id, task_user_id
                    )

                    if kb_id is None:
                        # Could not resolve - skip this binding
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
        # Note: We let unexpected errors propagate instead of swallowing them
        if bindings:
            if conn.dialect.name == "mysql":
                # MySQL: use INSERT IGNORE (duplicates are silently skipped)
                for binding in bindings:
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
            else:
                # SQLite: use INSERT OR IGNORE (duplicates are silently skipped)
                for binding in bindings:
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

        offset += batch_size

        # Safety check: if we've processed many batches without finding data, stop
        if offset > 10000000:  # 10 million records safety limit
            break

    print(
        f"Migrated {total_migrated} KB bindings to task_knowledge_base_bindings table"
    )


def downgrade() -> None:
    """Remove linked_group_id column, indexes, and task_knowledge_base_bindings table."""
    # Part 1: Drop composite indexes for KB binding queries
    op.drop_index(
        "idx_resource_members_user_type_status", table_name="resource_members"
    )
    op.drop_index("idx_tasks_user_kind_active", table_name="tasks")

    # Part 2: Drop task_knowledge_base_bindings table
    # Note: op.drop_constraint is not needed as constraints are dropped with the table
    # and it's not supported on SQLite
    op.drop_index("idx_tkb_kb_id", table_name="task_knowledge_base_bindings")
    op.drop_index("idx_tkb_task_id", table_name="task_knowledge_base_bindings")
    op.drop_table("task_knowledge_base_bindings")

    # Part 3: Drop is_group_chat column and indexes
    op.drop_index("ix_tasks_user_is_group_chat_updated", table_name="tasks")
    op.drop_index("ix_tasks_is_group_chat", table_name="tasks")
    op.drop_column("tasks", "is_group_chat")

    # Part 4: Drop linked_group_id column and indexes
    op.drop_index("ix_tasks_user_id_linked_group_id", table_name="tasks")
    op.drop_index("ix_tasks_linked_group_id", table_name="tasks")
    op.drop_column("tasks", "linked_group_id")
