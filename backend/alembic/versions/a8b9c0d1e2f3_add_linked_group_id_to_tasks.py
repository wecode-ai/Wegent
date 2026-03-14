# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add is_group_chat to tasks table and task_knowledge_base_bindings table

Revision ID: a8b9c0d1e2f3
Revises: c9900f078622
Create Date: 2026-03-10 14:00:00.000000

This migration includes performance optimizations:

1. is_group_chat column on tasks table:
   - Boolean flag to quickly identify group chat tasks
   - Enables efficient indexed queries for group chat list loading
   - Performance improvement: O(n) JSON scan -> O(log n) index lookup

2. task_knowledge_base_bindings table:
   - Stores Task-KnowledgeBase-Group relationships
   - Enables efficient indexed queries instead of JSON parsing
   - linked_group_id in this table associates group chats with namespaces

3. Composite indexes for optimized queries
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
    """Add is_group_chat column and task_knowledge_base_bindings table."""
    # Part 1: Add is_group_chat column to tasks table
    _upgrade_is_group_chat()

    # Part 2: Create task_knowledge_base_bindings table with linked_group_id
    _upgrade_task_kb_bindings()

    # Part 3: Create composite indexes for KB binding query optimization
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
            task_json = None
            is_group_chat = False
            try:
                task_json = json.loads(row[1]) if isinstance(row[1], str) else row[1]
                is_group_chat = task_json.get("spec", {}).get("is_group_chat")
            except (json.JSONDecodeError, ValueError, TypeError, AttributeError) as e:
                logger.warning(f"Failed to parse JSON for task id={task_id}: {e}")
                continue

            if is_group_chat is True:
                conn.execute(
                    sa.text("UPDATE tasks SET is_group_chat = 1 WHERE id = :task_id"),
                    {"task_id": task_id},
                )


def _upgrade_task_kb_bindings() -> None:
    """Create task_knowledge_base_bindings table with linked_group_id and migrate existing data."""

    # 1. Create the table with linked_group_id
    op.create_table(
        "task_knowledge_base_bindings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("knowledge_base_id", sa.Integer(), nullable=False),
        sa.Column(
            "linked_group_id", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
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
    # Note: idx_tkb_task_id and idx_tkb_kb_id are covered by the UNIQUE constraint uk_task_kb
    # which includes (task_id, knowledge_base_id), so separate indexes are not needed
    # op.create_index("idx_tkb_task_id", "task_knowledge_base_bindings", ["task_id"])
    # op.create_index(
    #     "idx_tkb_kb_id", "task_knowledge_base_bindings", ["knowledge_base_id"]
    # )

    # Composite index for group member sync queries
    # Optimizes: SELECT task_id FROM task_knowledge_base_bindings WHERE linked_group_id = ?
    op.create_index(
        "idx_tkb_linked_group_task",
        "task_knowledge_base_bindings",
        ["linked_group_id", "task_id"],
    )

    # Index for knowledge_base_id lookups
    # Optimizes: SELECT * FROM task_knowledge_base_bindings WHERE knowledge_base_id = ?
    op.create_index(
        "idx_tkb_kb_id",
        "task_knowledge_base_bindings",
        ["knowledge_base_id"],
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

            # Ensure kb_json is a dict before using .get()
            if not isinstance(kb_json, dict):
                continue

            kb_spec = kb_json.get("spec", {})
            # Ensure kb_spec is a dict before using .get()
            if not isinstance(kb_spec, dict):
                continue

            display_name = kb_spec.get("name")
            if display_name == kb_name:
                matching_kbs.append(kb_id)
        except (json.JSONDecodeError, TypeError, AttributeError):
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


def _resolve_namespace_by_name(conn, group_name: str) -> Optional[int]:
    """Resolve namespace ID by group name.

    Args:
        conn: Database connection
        group_name: Group/namespace name

    Returns:
        Namespace ID if found, None otherwise
    """
    if not group_name:
        return None

    if conn.dialect.name == "mysql":
        result = conn.execute(
            sa.text("SELECT id FROM namespace WHERE name = :name AND is_active = true"),
            {"name": group_name},
        ).fetchone()
    else:
        result = conn.execute(
            sa.text("SELECT id FROM namespace WHERE name = :name AND is_active = 1"),
            {"name": group_name},
        ).fetchone()

    return result[0] if result else None


def _migrate_kb_bindings() -> None:
    """Migrate existing knowledgeBaseRefs from JSON to the bindings table.

    This function:
    1. Queries all Tasks with knowledgeBaseRefs in their JSON
    2. Extracts KB bindings with valid IDs
    3. For legacy refs without ID, resolves KB by name
    4. Extracts linked_group from task JSON and resolves to namespace_id
    5. Batch inserts into the new table
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

            # Ensure task_json is a dict before using .get()
            if not isinstance(task_json, dict):
                logger.warning(
                    f"Skipping task {task_id}: task_json is not a dict, got {type(task_json).__name__}"
                )
                continue

            # For SQLite: filter to only group-chat tasks in Python
            if conn.dialect.name != "mysql":
                spec_for_filter = task_json.get("spec", {})
                if not isinstance(spec_for_filter, dict):
                    continue
                if spec_for_filter.get("is_group_chat") is not True:
                    continue

            # Extract linked_group for namespace_id resolution
            spec = task_json.get("spec", {})
            # Ensure spec is a dict before accessing keys
            if not isinstance(spec, dict):
                logger.warning(
                    f"Skipping task {task_id}: spec is not a dict, got {type(spec).__name__}"
                )
                continue
            linked_group_name = spec.get("linked_group")
            linked_group_id = 0

            if isinstance(linked_group_name, str) and linked_group_name.strip():
                linked_group_id = (
                    _resolve_namespace_by_name(conn, linked_group_name) or 0
                )

            # Extract knowledgeBaseRefs
            kb_refs = spec.get("knowledgeBaseRefs", []) or []

            # Ensure kb_refs is a list
            if not isinstance(kb_refs, list):
                logger.warning(
                    f"Invalid knowledgeBaseRefs type for task {task_id}: {type(kb_refs)}. Expected list."
                )
                continue

            for ref in kb_refs:
                # Validate that ref is a dict
                if not isinstance(ref, dict):
                    logger.warning(
                        f"Skipping invalid KB ref (not a dict) for task {task_id}: {type(ref)}"
                    )
                    continue

                kb_id = ref.get("id")

                # Validate kb_id: explicitly reject booleans before int check
                if isinstance(kb_id, bool):
                    logger.warning(
                        f"Invalid KB id (boolean) for task {task_id}: {kb_id}"
                    )
                    kb_id = None
                elif kb_id is not None:
                    if isinstance(kb_id, int):
                        pass  # Valid int, use as-is
                    elif isinstance(kb_id, str):
                        try:
                            kb_id = int(kb_id)
                        except ValueError:
                            logger.warning(
                                f"Invalid KB id (non-numeric string) for task {task_id}: {kb_id}"
                            )
                            kb_id = None
                    else:
                        # Malformed values like {}, [], ""
                        logger.warning(
                            f"Invalid KB id type for task {task_id}: {type(kb_id)}"
                        )
                        kb_id = None

                # If no ID, try to resolve by name (legacy data)
                if kb_id is None:
                    kb_name = ref.get("name") or ref.get("knowledgeBaseName")
                    kb_namespace = ref.get("namespace", "default")

                    # Normalize kb_name: ensure it's a non-empty string
                    if not isinstance(kb_name, str):
                        kb_name = None
                    elif not kb_name.strip():
                        kb_name = None

                    # Normalize kb_namespace: ensure it's a non-empty string
                    if not isinstance(kb_namespace, str):
                        kb_namespace = "default"
                    elif not kb_namespace.strip():
                        kb_namespace = "default"

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

                # Normalize bound_by: ensure it's a non-empty string
                bound_by = ref.get("boundBy")
                if not isinstance(bound_by, str) or not bound_by.strip():
                    bound_by = "migration"

                bound_at_str = ref.get("boundAt")

                # Validate and coerce bound_at_str to string
                if bound_at_str is not None and not isinstance(bound_at_str, str):
                    logger.warning(
                        f"Invalid boundAt type for task {task_id}, expected str got {type(bound_at_str)}. Using current time."
                    )
                    bound_at_str = None

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
                        "linked_group_id": linked_group_id,
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
                            (task_id, knowledge_base_id, linked_group_id, bound_by, bound_at)
                            VALUES (:task_id, :knowledge_base_id, :linked_group_id, :bound_by, :bound_at)
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
                            (task_id, knowledge_base_id, linked_group_id, bound_by, bound_at)
                            VALUES (:task_id, :knowledge_base_id, :linked_group_id, :bound_by, :bound_at)
                        """
                        ),
                        binding,
                    )
                    total_migrated += 1

        offset += batch_size

    print(
        f"Migrated {total_migrated} KB bindings to task_knowledge_base_bindings table"
    )


def downgrade() -> None:
    """Remove is_group_chat column, indexes, and task_knowledge_base_bindings table."""
    # Part 1: Drop composite indexes for KB binding queries
    op.drop_index(
        "idx_resource_members_user_type_status", table_name="resource_members"
    )
    op.drop_index("idx_tasks_user_kind_active", table_name="tasks")

    # Part 2: Drop task_knowledge_base_bindings table
    # Note: op.drop_constraint is not needed as constraints are dropped with the table
    # and it's not supported on SQLite
    op.drop_index(
        "idx_tkb_linked_group_task", table_name="task_knowledge_base_bindings"
    )
    op.drop_index("idx_tkb_kb_id", table_name="task_knowledge_base_bindings")
    op.drop_table("task_knowledge_base_bindings")

    # Part 3: Drop is_group_chat column and indexes
    op.drop_index("ix_tasks_user_is_group_chat_updated", table_name="tasks")
    op.drop_index("ix_tasks_is_group_chat", table_name="tasks")
    op.drop_column("tasks", "is_group_chat")
