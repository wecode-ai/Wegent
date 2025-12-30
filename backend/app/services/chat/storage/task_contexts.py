# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task-level contexts aggregation service.

This module provides functions to sync and retrieve task-level context information
for global visibility across all subtasks in a task.
"""

import logging
from typing import List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.subtask_context import ContextType, SubtaskContext
from app.models.task import TaskResource

logger = logging.getLogger(__name__)


def sync_task_contexts(
    db: Session,
    task: TaskResource,
    new_context_objects: List[SubtaskContext],
) -> None:
    """
    Incrementally merge new context objects to Task's contexts field.

    This function updates the task's JSON field to include new subtask contexts,
    enabling task-level context aggregation for global visibility.

    Args:
        db: Database session
        task: TaskResource object (already loaded, no additional query needed)
        new_context_objects: List of SubtaskContext objects to add
    """
    if not new_context_objects:
        return

    new_context_entries = [
        {"id": ctx.id, "context_type": ctx.context_type} for ctx in new_context_objects
    ]

    # Get existing contexts from Task JSON
    task_contexts = task.json.get("contexts", {})
    existing_entries = task_contexts.get("subtask_contexts", [])
    existing_ids = {entry["id"] for entry in existing_entries}

    # Incremental merge (deduplicate by id)
    added_count = 0
    for entry in new_context_entries:
        if entry["id"] not in existing_ids:
            existing_entries.append(entry)
            existing_ids.add(entry["id"])
            added_count += 1

    # Update Task JSON
    task.json["contexts"] = {"subtask_contexts": existing_entries}
    flag_modified(task, "json")

    logger.info(
        f"[sync_task_contexts] Task {task.id}: added {added_count} contexts, "
        f"total={len(existing_entries)}"
    )


def get_kb_context_ids_from_task(
    db: Session,
    task_id: int,
) -> List[int]:
    """
    Get knowledge base context IDs from Task's contexts field.
    No database query needed - filter directly from JSON.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        List of subtask_context IDs with context_type='knowledge_base'
    """
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active,
        )
        .first()
    )

    if not task:
        return []

    task_contexts = task.json.get("contexts", {})
    subtask_contexts = task_contexts.get("subtask_contexts", [])

    # Filter by context_type directly from JSON (no DB query)
    return [
        entry["id"]
        for entry in subtask_contexts
        if entry.get("context_type") == ContextType.KNOWLEDGE_BASE.value
    ]


def get_kb_contexts_from_task(
    db: Session,
    task_id: int,
) -> List[SubtaskContext]:
    """
    Get knowledge base SubtaskContext records from Task's contexts.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        List of SubtaskContext records with context_type='knowledge_base'
    """
    kb_context_ids = get_kb_context_ids_from_task(db, task_id)

    if not kb_context_ids:
        return []

    return (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(kb_context_ids),
            SubtaskContext.context_type == ContextType.KNOWLEDGE_BASE.value,
        )
        .all()
    )
