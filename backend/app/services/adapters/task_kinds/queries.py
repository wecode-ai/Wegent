# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task query methods."""

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from pydantic import ValidationError
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
        except ValidationError as e:
            # Pydantic validation failure for Task.model_validate
            logger.warning(
                f"[_filter_and_paginate_tasks] Failed to validate task {task.id}: {e}. "
                f"task_json_type={type(task.json).__name__}, task_json_len={len(str(task.json)) if task.json else 0}",
                exc_info=True,
            )
            continue
        except (KeyError, TypeError, ValueError) as e:
            # Malformed input data (e.g., missing keys, wrong types)
            logger.warning(
                f"[_filter_and_paginate_tasks] Malformed task data for task {task.id}: {e}. "
                f"task_json_type={type(task.json).__name__}, task_json_len={len(str(task.json)) if task.json else 0}",
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
        # Step 1: Get candidate task IDs with expanded limit to accommodate filtering
        # We fetch more IDs than needed because some will be filtered out
        candidate_limit = limit + 200  # Fetch extra to accommodate filtering
        task_ids, _ = get_accessible_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=candidate_limit, extra_limit=0
        )

        if not task_ids:
            return [], 0

        # Step 2: Load task data for the IDs
        tasks = load_tasks_by_ids(db, task_ids)

        # Step 3: Filter tasks and get filtered ID list
        filtered_tasks = []
        for task in tasks:
            try:
                task_crd = Task.model_validate(task.json)
            except ValidationError:
                continue

            status = task_crd.status.status if task_crd.status else "PENDING"
            if status == "DELETE":
                continue
            if is_background_task(task_crd):
                continue
            if is_non_interacted_subscription_task(task_crd):
                continue

            filtered_tasks.append(task)

        # Step 4: Compute total from filtered results
        total = len(filtered_tasks)

        # Step 5: Apply pagination (skip + limit) to filtered tasks
        # Restore order from original task_ids
        id_to_task = {t.id: t for t in filtered_tasks}
        ordered_filtered_tasks = restore_task_order(
            task_ids, id_to_task, limit=len(task_ids)
        )
        paginated_tasks = ordered_filtered_tasks[skip : skip + limit]

        if not paginated_tasks:
            return [], total

        # Step 6: Build result with related data
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
        Get user's Task list with pagination (lightweight list response).

        Includes tasks owned by user and tasks where user is an approved member.
        """
        # Step 1: Get candidate task IDs with expanded limit to accommodate filtering
        # We fetch more IDs than needed because some will be filtered out
        candidate_limit = limit + 200  # Fetch extra to accommodate filtering
        task_ids, _ = get_accessible_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=candidate_limit, extra_limit=0
        )
        if not task_ids:
            return [], 0

        # Step 2: Load task data for the IDs
        tasks = load_tasks_by_ids(db, task_ids)

        # Step 3: Filter tasks for display (DELETE, background, non-interacted subscriptions)
        id_to_task = filter_tasks_for_display(tasks)

        # Step 4: Compute total from filtered results
        total = len(id_to_task)

        # Step 5: Restore order and apply pagination (skip + limit)
        filtered_tasks = restore_task_order(task_ids, id_to_task, limit=len(task_ids))
        paginated_tasks = filtered_tasks[skip : skip + limit]
        if not paginated_tasks:
            return [], total

        result = build_lite_task_list(db, paginated_tasks, user_id)
        return result, total

    def get_user_group_tasks_lite(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 50
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's group chat task list with pagination (lightweight version).

        Returns only group chat tasks sorted by updated_at descending.
        """
        all_group_task_ids = get_group_task_ids_for_accessible_user(db, user_id=user_id)
        if not all_group_task_ids:
            return [], 0

        group_task_ids = list(all_group_task_ids)
        total = count_non_deleted_tasks_by_ids(db, group_task_ids)
        if total == 0:
            return [], 0

        paginated_tasks = load_tasks_by_ids_ordered(
            db,
            group_task_ids,
            order_field="updated_at",
            descending=True,
            skip=skip,
            limit=limit,
            exclude_deleted=True,
        )
        result = build_lite_task_list(db, paginated_tasks, user_id)
        return result, total

    def get_user_personal_tasks_lite(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 50,
        types: List[str] = None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's personal (non-group-chat) task list with pagination.

        Args:
            types: include task types. supports: online, offline, subscription, flow.
                   Defaults to online and offline.
        """
        if types is None:
            types = ["online", "offline"]

        all_group_task_ids = get_group_task_ids_for_owned_tasks(db, user_id=user_id)
        task_ids, total_owned = get_owned_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=limit, extra_limit=200
        )
        adjusted_total = max(total_owned - len(all_group_task_ids), 0)

        if not task_ids:
            return [], adjusted_total

        tasks = load_tasks_by_ids(db, task_ids)
        valid_tasks = self._filter_personal_tasks(tasks, all_group_task_ids, types)
        id_to_task = {task.id: task for task in valid_tasks}
        ordered_tasks = restore_task_order(task_ids, id_to_task, limit)

        result = build_lite_task_list(db, ordered_tasks, user_id)
        return result, max(adjusted_total, len(ordered_tasks))

    def _filter_personal_tasks(
        self,
        tasks: List[TaskResource],
        all_group_task_ids: set,
        types: List[str],
    ) -> List[TaskResource]:
        """Filter personal tasks based on type criteria."""
        valid_tasks = []
        include_online = "online" in types
        include_offline = "offline" in types
        include_subscription = "subscription" in types or "flow" in types

        for task in tasks:
            if task.id in all_group_task_ids:
                continue

            task_crd = Task.model_validate(task.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            if status == "DELETE":
                continue

            labels = task_crd.metadata.labels or {}
            is_subscription = labels.get("type") == "subscription"
            task_type_label = labels.get("taskType", "chat")
            is_code = task_type_label == "code"

            if is_subscription:
                if not include_subscription:
                    continue
            elif is_code:
                if not include_offline:
                    continue
            else:
                if not include_online:
                    continue

            valid_tasks.append(task)

        return valid_tasks

    def get_user_tasks_by_title_with_pagination(
        self, db: Session, *, user_id: int, title: str, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """Fuzzy search tasks by title for current user (pagination)."""
        task_ids, _ = get_owned_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=limit, extra_limit=100
        )
        if not task_ids:
            return [], 0

        tasks = load_tasks_by_ids(db, task_ids)
        title_lower = title.lower()
        id_to_task = filter_tasks_with_title_match(tasks, title_lower)
        filtered_tasks = restore_task_order(task_ids, id_to_task, limit)
        total = len(id_to_task)
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
