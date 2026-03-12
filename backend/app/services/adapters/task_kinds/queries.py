# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task query methods."""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import bindparam, func, text
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.schemas.kind import Task

from .converters import convert_to_task_dict, convert_to_task_dict_optimized
from .filters import (
    filter_tasks_for_display,
    filter_tasks_with_title_match,
    is_background_task,
    is_non_interacted_subscription_task,
)
from .helpers import build_lite_task_list, get_tasks_related_data_batch
from .query_utils import (
    count_non_deleted_tasks_by_ids,
    get_accessible_task_ids_and_total,
    get_group_task_ids_for_accessible_user,
    get_group_task_ids_for_owned_tasks,
    get_owned_task_ids_and_total,
    load_tasks_by_ids,
    load_tasks_by_ids_ordered,
    restore_task_order,
)
from .task_detail_helpers import (
    add_group_chat_info_to_task,
    convert_subtasks_to_dict,
    get_bots_for_subtasks,
)
from .task_skills_resolver import resolve_task_skills

logger = logging.getLogger(__name__)


def parse_is_group_chat(task_id: int, task_json: Any) -> bool:
    """Parse is_group_chat field from task JSON.

    Args:
        task_id: Task ID for logging purposes
        task_json: Task JSON data (expected to be a dict)

    Returns:
        True if is_group_chat is explicitly True, False otherwise
    """
    try:
        if isinstance(task_json, dict):
            return task_json.get("spec", {}).get("is_group_chat") is True
        # Non-dict task_json is malformed - log warning
        logger.warning(
            f"[parse_is_group_chat] Malformed task_json for task_id={task_id}: "
            f"expected dict, got {type(task_json).__name__}"
        )
        return False
    except (KeyError, TypeError, ValueError) as e:
        logger.warning(
            f"[parse_is_group_chat] Failed to parse is_group_chat for task_id={task_id}: {e}"
        )
        return False


def is_group_task_or_linked(task_id: int, task_json: Any) -> bool:
    """Check if a task is a group task or has a linked group.

    This helper determines if a task should be considered a "group task"
    based on either:
    1. is_group_chat flag in spec
    2. linked_group being set in spec (indicates linked namespace)

    Args:
        task_id: Task ID for logging purposes
        task_json: Task JSON data (expected to be a dict)

    Returns:
        True if the task is a group task or has a linked group
        False otherwise (including malformed data)
    """
    try:
        if not isinstance(task_json, dict):
            return False

        spec = task_json.get("spec", {})

        # Check is_group_chat flag
        if spec.get("is_group_chat") is True:
            return True

        # Check linked_group in spec (indicates linked namespace)
        if spec.get("linked_group"):
            return True

        return False
    except (KeyError, TypeError, ValueError):
        return False


def _filter_and_paginate_tasks(
    tasks: List[TaskResource],
    ordered_task_ids: List[int],
    skip: int,
    limit: int,
) -> List[TaskResource]:
    """Filter tasks for display and apply pagination.

    Filters out DELETE status tasks, background tasks, and non-interacted subscriptions.
    Maintains the order from ordered_task_ids.

    Args:
        tasks: List of TaskResource objects to filter
        ordered_task_ids: Original ordered task IDs for maintaining sort order
        skip: Number of items to skip
        limit: Maximum number of items to return

    Returns:
        Filtered and paginated list of TaskResource objects
    """
    # Filter tasks for display
    filtered_tasks = []
    for task in tasks:
        try:
            task_crd = Task.model_validate(task.json)
        except Exception:
            continue

        status = task_crd.status.status if task_crd.status else "PENDING"
        if status == "DELETE":
            continue
        if is_background_task(task_crd):
            continue
        if is_non_interacted_subscription_task(task_crd):
            continue

        filtered_tasks.append(task)

    # Restore order and apply pagination
    id_to_task = {t.id: t for t in filtered_tasks}
    ordered_tasks = restore_task_order(
        ordered_task_ids, id_to_task, limit=len(ordered_task_ids)
    )

    # Apply pagination to filtered results
    return ordered_tasks[skip : skip + limit]


class TaskQueryMixin:
    """Mixin class providing task query methods."""

    def get_user_tasks_with_pagination(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (only active tasks, excluding DELETE status).

        Optimized version using raw SQL to avoid MySQL "Out of sort memory" errors.
        DELETE status tasks are filtered in application layer.
        Includes tasks owned by user AND tasks user is a member of (group chats).
        """
        # Step 1: Get paginated task IDs and total count
        task_ids, total = get_accessible_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=limit, extra_limit=50
        )

        if not task_ids:
            return [], total

        # Step 2: Load task data for the IDs
        tasks = load_tasks_by_ids(db, task_ids)

        # Step 3: Filter and paginate
        paginated_tasks = _filter_and_paginate_tasks(tasks, task_ids, skip, limit)

        if not paginated_tasks:
            return [], total

        # Step 4: Build result with related data
        related_data_batch = get_tasks_related_data_batch(db, paginated_tasks, user_id)
        result = []
        for task in paginated_tasks:
            task_crd = Task.model_validate(task.json)
            task_related_data = related_data_batch.get(str(task.id), {})
            result.append(
                convert_to_task_dict_optimized(task, task_related_data, task_crd)
            )

        return result, total

    def get_user_tasks_lite(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (lightweight version for list display).

        Only returns essential fields without JOIN queries for better performance.
        Includes tasks owned by user AND tasks user is a member of (group chats).
        """
        # Step 1: Get paginated task IDs and total count
        task_ids, total = get_accessible_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=limit, extra_limit=50
        )

        if not task_ids:
            return [], total

        # Step 2: Load task data for the IDs
        tasks = load_tasks_by_ids(db, task_ids)

        # Step 3: Filter and paginate
        paginated_tasks = _filter_and_paginate_tasks(tasks, task_ids, skip, limit)

        if not paginated_tasks:
            return [], total

        # Build lightweight result
        result = build_lite_task_list(db, paginated_tasks, user_id)

        return result, total

    def get_user_group_tasks_lite(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 50
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's group chat task list with pagination (lightweight version).

        Returns only group chat tasks sorted by updated_at descending.
        Includes:
        1. Tasks with is_group_chat=true (using indexed column)
        2. Tasks with ResourceMember records (regular group chats)
        3. Tasks with linked_group where user is a member of the linked group (namespace)

        Performance optimized: Uses is_group_chat column with index instead of JSON parsing.
        """
        from app.schemas.namespace import GroupRole

        # Step 1: Get all task IDs with is_group_chat=true (no limit/skip)
        group_chat_tasks_sql = text(
            """
            SELECT id, updated_at
            FROM tasks
            WHERE user_id = :user_id
            AND kind = 'Task'
            AND is_active = true
            AND namespace != 'system'
            AND is_group_chat = true
            ORDER BY updated_at DESC
        """
        )
        group_chat_tasks_result = db.execute(
            group_chat_tasks_sql, {"user_id": user_id}
        ).fetchall()
        group_task_ids = {row[0] for row in group_chat_tasks_result}
        group_task_updated_at = {row[0]: row[1] for row in group_chat_tasks_result}

        # Step 2: Get tasks with linked_group where user is a member of the linked namespace
        # Exclude RestrictedObserver role - they should not have task access via linked group
        user_namespace_ids_sql = text(
            """
            SELECT DISTINCT rm.resource_id, rm.role
            FROM resource_members rm
            WHERE rm.resource_type = 'Namespace'
            AND rm.user_id = :user_id
            AND rm.status = 'approved'
        """
        )
        user_namespace_ids_result = db.execute(
            user_namespace_ids_sql, {"user_id": user_id}
        ).fetchall()
        # Filter out RestrictedObserver role
        user_namespace_ids = {
            row[0]
            for row in user_namespace_ids_result
            if row[1] != GroupRole.RestrictedObserver.value
        }

        linked_group_ids = set()
        linked_group_updated_at = {}
        if user_namespace_ids:
            # Query tasks using linked_group_id column (indexed)
            linked_group_sql = text(
                """
                SELECT DISTINCT k.id, k.updated_at
                FROM tasks k
                WHERE k.kind = 'Task'
                AND k.is_active = true
                AND k.namespace != 'system'
                AND k.linked_group_id IN :namespace_ids
            """
            ).bindparams(
                bindparam("namespace_ids", expanding=True),
            )

            linked_group_result = db.execute(
                linked_group_sql,
                {
                    "namespace_ids": list(user_namespace_ids),
                },
            ).fetchall()
            linked_group_ids = {row[0] for row in linked_group_result}
            linked_group_updated_at = {row[0]: row[1] for row in linked_group_result}

        # Step 3: Get all tasks where user is a member via resource_members (no limit)
        # Note: copied_resource_id = 0 filters out share-copy records
        member_task_ids_sql = text(
            """
            SELECT DISTINCT tm.resource_id, k.updated_at
            FROM resource_members tm
            INNER JOIN tasks k ON k.id = tm.resource_id AND tm.resource_type = 'Task'
            WHERE tm.status = 'approved'
            AND k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND tm.user_id = :user_id
            AND tm.copied_resource_id = 0
        """
        )
        member_task_ids_result = db.execute(
            member_task_ids_sql, {"user_id": user_id}
        ).fetchall()
        member_task_ids = {row[0] for row in member_task_ids_result}
        member_task_updated_at = {row[0]: row[1] for row in member_task_ids_result}

        # Step 4: Combine all task IDs (union/deduplication)
        all_group_task_ids = group_task_ids | linked_group_ids | member_task_ids

        if not all_group_task_ids:
            return [], 0

        # Step 5: Load TaskResource rows for all IDs to filter out DELETE tasks
        all_tasks = (
            db.query(TaskResource).filter(TaskResource.id.in_(all_group_task_ids)).all()
        )

        # Filter out tasks with status == "DELETE" and build non-deleted ID set
        non_deleted_ids = []
        non_deleted_updated_at = {}
        for t in all_tasks:
            task_crd = Task.model_validate(t.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            if status != "DELETE":
                non_deleted_ids.append(t.id)
                # Get updated_at from the appropriate source
                if t.id in group_task_updated_at:
                    non_deleted_updated_at[t.id] = group_task_updated_at[t.id]
                elif t.id in linked_group_updated_at:
                    non_deleted_updated_at[t.id] = linked_group_updated_at[t.id]
                elif t.id in member_task_updated_at:
                    non_deleted_updated_at[t.id] = member_task_updated_at[t.id]
                else:
                    non_deleted_updated_at[t.id] = t.updated_at

        # Step 6: Compute total from filtered non-deleted set
        total = len(non_deleted_ids)

        logger.info(
            f"[get_user_group_tasks_lite] user_id={user_id}, "
            f"is_group_chat={len(group_task_ids)}, "
            f"linked_group={len(linked_group_ids)}, "
            f"member_tasks={len(member_task_ids)}, "
            f"total={total}"
        )

        if not non_deleted_ids:
            return [], 0

        # Step 7: Sort by updated_at descending and apply pagination
        sorted_task_ids = sorted(
            non_deleted_ids,
            key=lambda tid: non_deleted_updated_at.get(tid, None) or datetime.min,
            reverse=True,
        )

        # Apply skip/limit to get paginated IDs
        paginated_ids = sorted_task_ids[skip : skip + limit]

        if not paginated_ids:
            return [], total

        # Step 8: Load full task data for paginated IDs (or reuse already-loaded rows)
        id_to_task = {t.id: t for t in all_tasks}
        ordered_tasks = [id_to_task[tid] for tid in paginated_ids if tid in id_to_task]

        # Build lightweight result
        result = build_lite_task_list(db, ordered_tasks, user_id)

        return result, total

    def get_user_personal_tasks_lite(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 50,
        types: Optional[List[str]] = None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's personal (non-group-chat) task list with pagination.

        Args:
            types: List of task types to include. Options: 'online', 'offline', 'subscription'.
                   Default is ['online', 'offline'] if None.

        Performance optimized: Uses application-layer filtering instead of JSON_EXTRACT.
        """
        if types is None:
            types = ["online", "offline"]

        # Get all task IDs that are group chats (have members) using resource_members
        # Note: copied_resource_id = 0 filters out share-copy records (where copied_resource_id > 0)
        # Share-copy records are created when users import shared tasks, not for group chat membership
        member_task_ids_sql = text(
            """
            SELECT DISTINCT tm.resource_id
            FROM resource_members tm
            INNER JOIN tasks k ON k.id = tm.resource_id AND tm.resource_type = 'Task'
            WHERE tm.status = 'approved'
            AND k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND tm.copied_resource_id = 0
            AND tm.user_id = :user_id
        """
        )
        member_task_ids_result = db.execute(
            member_task_ids_sql, {"user_id": user_id}
        ).fetchall()
        member_task_ids = {row[0] for row in member_task_ids_result}

        # Also get task IDs where is_group_chat is explicitly set to true
        # Using application-layer filtering to avoid JSON_EXTRACT in SQL
        explicit_group_sql = text(
            """
            SELECT DISTINCT k.id, k.json
            FROM tasks k
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND k.user_id = :user_id
        """
        )
        explicit_group_result = db.execute(
            explicit_group_sql, {"user_id": user_id}
        ).fetchall()

        # Filter tasks that are group tasks (is_group_chat=true or has linked_group)
        # Using the unified helper to ensure consistent definition of "group task"
        explicit_group_ids = set()
        for row in explicit_group_result:
            task_id, task_json = row
            if task_id in member_task_ids:
                continue  # Already counted
            if is_group_task_or_linked(task_id, task_json):
                explicit_group_ids.add(task_id)

        # Combine all group task IDs to exclude
        all_group_task_ids = member_task_ids | explicit_group_ids

        # Get all user's owned tasks first (before pagination)
        all_tasks_sql = text(
            """
            SELECT k.id, k.json
            FROM tasks k
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND k.user_id = :user_id
            ORDER BY k.created_at DESC
        """
        )
        all_tasks_result = db.execute(all_tasks_sql, {"user_id": user_id}).fetchall()

        # Filter tasks: exclude group tasks, deleted tasks, and apply type filters
        include_online = "online" in types
        include_offline = "offline" in types
        include_subscription = "subscription" in types

        filtered_task_ids = []
        for row in all_tasks_result:
            task_id, task_json = row

            # Skip group chat tasks
            if task_id in all_group_task_ids:
                continue

            # Parse task to check status and type
            try:
                task_crd = Task.model_validate(task_json)
            except Exception:
                continue

            status = task_crd.status.status if task_crd.status else "PENDING"
            if status == "DELETE":
                continue

            # Determine task type from labels
            labels = task_crd.metadata.labels or {}
            is_subscription = labels.get("type") == "subscription"
            task_type_label = labels.get("taskType", "chat")
            is_code = task_type_label == "code"

            # Apply type filter
            if is_subscription:
                if not include_subscription:
                    continue
            elif is_code:
                if not include_offline:
                    continue
            else:
                if not include_online:
                    continue

            filtered_task_ids.append(task_id)

        # Calculate total from filtered results
        total = len(filtered_task_ids)

        # Apply pagination to the filtered ID list
        paginated_ids = filtered_task_ids[skip : skip + limit]

        if not paginated_ids:
            return [], total

        # Load full task data for paginated IDs
        tasks = db.query(TaskResource).filter(TaskResource.id.in_(paginated_ids)).all()

        # Maintain order
        id_to_task = {t.id: t for t in tasks}
        ordered_tasks = [id_to_task[tid] for tid in paginated_ids if tid in id_to_task]

        # Build lightweight result
        result = build_lite_task_list(db, ordered_tasks, user_id)

        return result, total

    def get_user_tasks_by_title_with_pagination(
        self, db: Session, *, user_id: int, title: str, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Fuzzy search tasks by title for current user (pagination).

        Excludes DELETE status tasks.
        """
        # Get all user's tasks first (before pagination)
        all_ids_sql = text(
            """
            SELECT id, json FROM tasks
            WHERE user_id = :user_id
            AND kind = 'Task'
            AND is_active = true
            AND namespace != 'system'
            ORDER BY created_at DESC
        """
        )
        all_tasks_result = db.execute(all_ids_sql, {"user_id": user_id}).fetchall()

        # Filter by title and other criteria
        title_lower = title.lower()
        filtered_task_ids = []
        for row in all_tasks_result:
            task_id, task_json = row
            try:
                task_crd = Task.model_validate(task_json)
            except Exception:
                continue

            status = task_crd.status.status if task_crd.status else "PENDING"
            if status == "DELETE":
                continue

            task_title = task_crd.spec.title or ""
            if title_lower not in task_title.lower():
                continue

            # Filter out non-interacted Subscription tasks
            if is_non_interacted_subscription_task(task_crd):
                continue

            filtered_task_ids.append(task_id)

        # Calculate total from filtered results
        total = len(filtered_task_ids)

        # Apply pagination to the filtered ID list
        paginated_ids = filtered_task_ids[skip : skip + limit]

        if not paginated_ids:
            return [], total

        # Load full task data for paginated IDs
        tasks = db.query(TaskResource).filter(TaskResource.id.in_(paginated_ids)).all()

        # Maintain order
        id_to_task = {t.id: t for t in tasks}
        filtered_tasks = [id_to_task[tid] for tid in paginated_ids if tid in id_to_task]

        if not filtered_tasks:
            return [], total

        related_data_batch = get_tasks_related_data_batch(db, filtered_tasks, user_id)
        result = []
        for task in filtered_tasks:
            task_crd = Task.model_validate(task.json)
            task_related_data = related_data_batch.get(str(task.id), {})
            result.append(
                convert_to_task_dict_optimized(task, task_related_data, task_crd)
            )

        return result, total

    def get_task_by_id(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get task by ID and user ID (only active tasks).

        Allows access if user is the owner OR a member of the group chat.

        Performance optimized: Uses application-layer status check instead of JSON_EXTRACT.
        """
        from app.services.task_member_service import task_member_service

        # Check if task exists (without JSON_EXTRACT in SQL)
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Check if user has access (owner or active member) BEFORE validating JSON
        # This prevents 500 errors from invalid JSON for unauthorized requests
        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(status_code=404, detail="Task not found")

        # Check DELETE status in application layer to avoid JSON_EXTRACT in SQL
        # Use defensive parsing to avoid ValidationError for malformed JSON
        try:
            task_crd = Task.model_validate(task.json)
            if task_crd.status and task_crd.status.status == "DELETE":
                raise HTTPException(status_code=404, detail="Task not found")
        except HTTPException:
            raise
        except ValidationError:
            # If validation fails, treat as not found
            raise HTTPException(status_code=404, detail="Task not found")
        except (KeyError, TypeError, ValueError) as e:
            # Handle other parsing errors
            logger.warning(f"[get_task_by_id] Failed to parse task {task_id}: {e}")
            raise HTTPException(status_code=404, detail="Task not found")

        # Use task owner's user_id for conversion
        convert_user_id = task.user_id
        return convert_to_task_dict(task, db, convert_user_id)

    def get_task_detail(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Dict[str, Any]:
        """Get detailed task information including related entities."""
        from app.services.adapters.team_kinds import team_kinds_service
        from app.services.readers.kinds import KindType, kindReader
        from app.services.readers.users import userReader
        from app.services.subtask import subtask_service
        from app.services.task_member_service import task_member_service

        task_dict = self.get_task_by_id(db, task_id=task_id, user_id=user_id)
        user = userReader.get_by_id(db, user_id)

        team_id = task_dict.get("team_id")
        team = None
        if team_id:
            logger.info(
                "[get_task_detail] task_id=%s, team_id=%s, user_id=%s",
                task_id,
                team_id,
                user_id,
            )
            team = kindReader.get_by_id(db, KindType.TEAM, team_id)
            if team:
                task_owner_id = task_member_service.get_task_owner_id(db, task_id)
                logger.info(
                    "[get_task_detail] task_owner_id=%s, team found: %s",
                    task_owner_id,
                    team is not None,
                )
                if task_owner_id:
                    team = team_kinds_service._convert_to_team_dict(
                        team, db, task_owner_id
                    )
                else:
                    logger.warning(
                        "[get_task_detail] task_owner_id is None for task_id=%s",
                        task_id,
                    )
                    team = None

        subtasks = subtask_service.get_by_task(
            db=db, task_id=task_id, user_id=user_id, from_latest=True
        )

        all_bot_ids = set()
        for subtask in subtasks:
            if subtask.bot_ids:
                all_bot_ids.update(subtask.bot_ids)

        bots = get_bots_for_subtasks(db, all_bot_ids)
        subtasks_dict = convert_subtasks_to_dict(subtasks, bots)

        task_dict["user"] = user
        task_dict["team"] = team
        task_dict["subtasks"] = subtasks_dict

        # Add group chat information
        self._add_group_chat_info_to_task(db, task_id, task_dict, user_id)

        return task_dict

    def _add_group_chat_info_to_task(
        self, db: Session, task_id: int, task_dict: Dict[str, Any], user_id: int
    ) -> None:
        """Add group chat information to task dict using ResourceMember."""
        # Delegate to the shared helper to populate group-chat metadata
        add_group_chat_info_to_task(
            db, task_id=task_id, task_dict=task_dict, user_id=user_id
        )

    def get_task_skills(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Dict[str, Any]:
        """Get all skills associated with a task."""
        return resolve_task_skills(db, task_id=task_id, user_id=user_id)
