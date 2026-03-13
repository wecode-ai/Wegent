# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task query methods."""

import json
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


def parse_is_group_chat(task_id: int, task_json: Any) -> Optional[bool]:
    """Parse is_group_chat field from task JSON.

    Args:
        task_id: Task ID for logging purposes
        task_json: Task JSON data (expected to be a dict)

    Returns:
        True if is_group_chat is explicitly True,
        False if explicitly False,
        None if task_json is malformed or parsing raises exceptions
    """
    try:
        if isinstance(task_json, dict):
            return task_json.get("spec", {}).get("is_group_chat") is True
        # Non-dict task_json is malformed - log warning and return None
        logger.warning(
            f"[parse_is_group_chat] Malformed task_json for task_id={task_id}: "
            f"expected dict, got {type(task_json).__name__}"
        )
        return None
    except (KeyError, TypeError, ValueError) as e:
        logger.warning(
            f"[parse_is_group_chat] Failed to parse is_group_chat for task_id={task_id}: {e}"
        )
        return None


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
        # Handle both string (from raw SQL) and dict (from ORM)
        if isinstance(task_json, str):
            task_json = json.loads(task_json)

        if not isinstance(task_json, dict):
            logger.warning(
                f"[is_group_task_or_linked] Malformed task_json for task_id={task_id}: "
                f"expected dict, got {type(task_json).__name__}"
            )
            return False

        spec = task_json.get("spec", {})
        spec = task_json.get("spec", {})

        # Check is_group_chat flag
        if spec.get("is_group_chat") is True:
            return True

        # Check linked_group in spec (indicates linked namespace)
        if spec.get("linked_group"):
            return True

        return False
    except (KeyError, TypeError, ValueError) as e:
        logger.warning(
            f"[is_group_task_or_linked] Failed to parse task_id={task_id}: {e}"
        )
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
        except Exception as e:
            logger.warning(
                f"[_filter_and_paginate_tasks] Failed to validate task {task.id}: {e}. "
                f"task_json={task.json}",
                exc_info=True,
            )
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

    # Apply limit only - skip was already applied in get_accessible_task_ids_and_total
    return ordered_tasks[:limit]


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

        Performance optimized: Uses query_utils helpers for efficient batch operations.
        """
        # Get all accessible group task IDs using existing helper
        all_group_task_ids = get_group_task_ids_for_accessible_user(db, user_id=user_id)
        if not all_group_task_ids:
            return [], 0

        group_task_ids = list(all_group_task_ids)

        # Count non-deleted tasks for accurate total
        total = count_non_deleted_tasks_by_ids(db, group_task_ids)
        if total == 0:
            return [], 0

        # Load paginated tasks with ordering and DELETE exclusion
        paginated_tasks = load_tasks_by_ids_ordered(
            db,
            group_task_ids,
            order_field="updated_at",
            descending=True,
            skip=skip,
            limit=limit,
            exclude_deleted=True,
        )

        # Build lightweight result
        result = build_lite_task_list(db, paginated_tasks, user_id)
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

        Performance optimized: Uses query_utils helpers for efficient batch operations.
        """
        if types is None:
            types = ["online", "offline"]

        # Get all owned task IDs using existing helper
        owned_task_ids, _ = get_owned_task_ids_and_total(
            db, user_id=user_id, skip=0, limit=10000, extra_limit=0
        )
        if not owned_task_ids:
            return [], 0

        # Get group task IDs to exclude
        group_task_ids = get_group_task_ids_for_owned_tasks(db, user_id=user_id)

        # Filter out group tasks
        personal_task_ids = [tid for tid in owned_task_ids if tid not in group_task_ids]
        if not personal_task_ids:
            return [], 0

        # Load tasks for filtering by status and type
        tasks = load_tasks_by_ids_ordered(
            db,
            personal_task_ids,
            order_field="created_at",
            descending=True,
            skip=0,
            limit=None,
            exclude_deleted=False,  # We'll filter manually to apply type filters
        )

        # Apply type filters
        include_online = "online" in types
        include_offline = "offline" in types
        include_subscription = "subscription" in types or "flow" in types

        filtered_tasks = []
        for task in tasks:
            try:
                task_crd = Task.model_validate(task.json)
            except Exception as e:
                logger.warning(
                    f"[get_user_personal_tasks_lite] Failed to validate task {task.id}: {e}. "
                    f"task_json={task.json}",
                    exc_info=True,
                )
                continue

            # Skip DELETE status
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

            filtered_tasks.append(task)

        # Calculate total and apply pagination
        total = len(filtered_tasks)
        paginated_tasks = filtered_tasks[skip : skip + limit]

        if not paginated_tasks:
            return [], total

        # Build lightweight result
        result = build_lite_task_list(db, paginated_tasks, user_id)
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
                # Handle both string (from raw SQL) and dict (from ORM)
                if isinstance(task_json, str):
                    task_json = json.loads(task_json)
                task_crd = Task.model_validate(task_json)
            except Exception as e:
                logger.warning(
                    f"[get_user_tasks_by_title_with_pagination] Failed to validate task {task_id}: {e}. "
                    f"task_json={task_json}",
                    exc_info=True,
                )
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
        except ValidationError as err:
            # If validation fails, treat as not found
            raise HTTPException(status_code=404, detail="Task not found") from err
        except (KeyError, TypeError, ValueError) as e:
            # Handle other parsing errors
            logger.warning(f"[get_task_by_id] Failed to parse task {task_id}: {e}")
            raise HTTPException(status_code=404, detail="Task not found") from e

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
