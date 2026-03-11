# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task query methods."""

import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
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
    """
    Parse is_group_chat field from task JSON.

    Args:
        task_id: Task ID for logging purposes
        task_json: Task JSON data (expected to be a dict)

    Returns:
        True if is_group_chat is explicitly True
        False if is_group_chat is explicitly False or not present
        None if parsing failed (malformed data)
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
    2. linked_group_id being set (> 0)

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

        # Check linked_group_id (could be in spec or as a column in the row)
        # In JSON, it would be under spec.linked_group
        if spec.get("linked_group"):
            return True

        return False
    except (KeyError, TypeError, ValueError):
        return False


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
        # Get all task IDs where user is owner OR member (using resource_members)
        # Exclude system namespace tasks (background tasks)
        # First, get all candidate tasks without pagination
        all_ids_sql = text(
            """
            SELECT DISTINCT k.id, k.json
            FROM tasks k
            LEFT JOIN resource_members tm ON k.id = tm.resource_id AND tm.resource_type = 'Task' AND tm.user_id = :user_id AND tm.status = 'approved'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
            ORDER BY k.created_at DESC
        """
        )

        task_ids, total = get_accessible_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=limit, extra_limit=50
        )
        all_tasks_result = db.execute(all_ids_sql, {"user_id": user_id}).fetchall()

        # Filter tasks for display (DELETE status, background tasks, non-interacted subscriptions)
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
            if is_background_task(task_crd):
                continue
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

    def get_user_tasks_lite(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (lightweight version for list display).

        Only returns essential fields without JOIN queries for better performance.
        Includes tasks owned by user AND tasks user is a member of (group chats).
        """
        # Get all task IDs where user is owner OR member (using resource_members)
        # Exclude system namespace tasks (background tasks)
        all_ids_sql = text(
            """
            SELECT DISTINCT k.id, k.json
            FROM tasks k
            LEFT JOIN resource_members tm ON k.id = tm.resource_id AND tm.resource_type = 'Task' AND tm.user_id = :user_id AND tm.status = 'approved'
            WHERE k.kind = 'Task'
            AND k.is_active = true
            AND k.namespace != 'system'
            AND (k.user_id = :user_id OR tm.id IS NOT NULL)
            ORDER BY k.created_at DESC
        """
        )

        task_ids, total = get_accessible_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=limit, extra_limit=50
        )
        all_tasks_result = db.execute(all_ids_sql, {"user_id": user_id}).fetchall()

        # Filter tasks for display (DELETE status, background tasks, non-interacted subscriptions)
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
            if is_background_task(task_crd):
                continue
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

        # Get task member counts in batch for is_group_chat detection using ResourceMember
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        task_ids_for_members = [t.id for t in filtered_tasks]
        member_counts = {}
        if task_ids_for_members:
            member_count_results = (
                db.query(
                    ResourceMember.resource_id,
                    func.count(ResourceMember.id).label("count"),
                )
                .filter(
                    ResourceMember.resource_type == ResourceType.TASK.value,
                    ResourceMember.resource_id.in_(task_ids_for_members),
                    ResourceMember.status == MemberStatus.APPROVED.value,
                )
                .group_by(ResourceMember.resource_id)
                .all()
            )
            member_counts = {row[0]: row[1] for row in member_count_results}

        # Build lightweight result
        result = build_lite_task_list(db, filtered_tasks, user_id)

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
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        # Step 1: Get tasks with is_group_chat=true using indexed column (fast)
        # This is the primary query for group chat tasks
        group_chat_tasks_sql = text(
            """
            SELECT id, json, updated_at
            FROM tasks
            WHERE user_id = :user_id
            AND kind = 'Task'
            AND is_active = true
            AND namespace != 'system'
            AND is_group_chat = true
            ORDER BY updated_at DESC
            LIMIT :limit OFFSET :skip
        """
        )
        group_chat_tasks_result = db.execute(
            group_chat_tasks_sql, {"user_id": user_id, "limit": limit, "skip": skip}
        ).fetchall()

        # Get total count for pagination
        count_sql = text(
            """
            SELECT COUNT(*)
            FROM tasks
            WHERE user_id = :user_id
            AND kind = 'Task'
            AND is_active = true
            AND namespace != 'system'
            AND is_group_chat = true
        """
        )
        total_result = db.execute(count_sql, {"user_id": user_id}).fetchone()
        total = total_result[0] if total_result else 0

        # Collect task IDs from the main query
        group_task_ids = {row[0] for row in group_chat_tasks_result}

        # Step 2: Get tasks with linked_group where user is a member of the linked namespace
        # This handles linked group chats that may not have is_group_chat set
        user_namespace_ids_sql = text(
            """
            SELECT DISTINCT rm.resource_id
            FROM resource_members rm
            WHERE rm.resource_type = 'Namespace'
            AND rm.user_id = :user_id
            AND rm.status = 'approved'
        """
        )
        user_namespace_ids_result = db.execute(
            user_namespace_ids_sql, {"user_id": user_id}
        ).fetchall()
        user_namespace_ids = {row[0] for row in user_namespace_ids_result}

        linked_group_ids = set()
        if user_namespace_ids:
            # Query tasks using linked_group_id column (indexed)
            linked_group_sql = text(
                """
                SELECT DISTINCT k.id
                FROM tasks k
                WHERE k.kind = 'Task'
                AND k.is_active = true
                AND k.namespace != 'system'
                AND k.linked_group_id IN :namespace_ids
                AND k.id NOT IN :existing_ids
            """
            ).bindparams(
                bindparam("namespace_ids", expanding=True),
                bindparam("existing_ids", expanding=True),
            )

            linked_group_result = db.execute(
                linked_group_sql,
                {
                    "namespace_ids": list(user_namespace_ids),
                    "existing_ids": list(group_task_ids) if group_task_ids else [0],
                },
            ).fetchall()
            linked_group_ids = {row[0] for row in linked_group_result}

        # Step 3: Get tasks where user is a member via resource_members (legacy support)
        # Note: copied_resource_id = 0 filters out share-copy records
        member_task_ids = set()
        if len(group_task_ids) < limit:
            remaining_limit = limit - len(group_task_ids)
            member_task_ids_sql = text(
                """
                SELECT DISTINCT tm.resource_id
                FROM resource_members tm
                INNER JOIN tasks k ON k.id = tm.resource_id AND tm.resource_type = 'Task'
                WHERE tm.status = 'approved'
                AND k.kind = 'Task'
                AND k.is_active = true
                AND k.namespace != 'system'
                AND tm.user_id = :user_id
                AND tm.copied_resource_id = 0
                AND k.id NOT IN :existing_ids
                LIMIT :limit
            """
            ).bindparams(
                bindparam("existing_ids", expanding=True),
            )
            member_task_ids_result = db.execute(
                member_task_ids_sql,
                {
                    "user_id": user_id,
                    "existing_ids": (
                        list(group_task_ids | linked_group_ids)
                        if (group_task_ids | linked_group_ids)
                        else [0]
                    ),
                    "limit": remaining_limit,
                },
            ).fetchall()
            member_task_ids = {row[0] for row in member_task_ids_result}

        # Combine all task IDs
        all_group_task_ids = group_task_ids | linked_group_ids | member_task_ids

        logger.info(
            f"[get_user_group_tasks_lite] user_id={user_id}, "
            f"is_group_chat={len(group_task_ids)}, "
            f"linked_group={len(linked_group_ids)}, "
            f"member_tasks={len(member_task_ids)}, "
            f"total={total}"
        )

        if not all_group_task_ids:
            return [], 0

        # Load full task data for all group chat IDs
        tasks = (
            db.query(TaskResource).filter(TaskResource.id.in_(all_group_task_ids)).all()
        )

        # Filter out DELETE status tasks
        valid_tasks = []
        for t in tasks:
            task_crd = Task.model_validate(t.json)
            status = task_crd.status.status if task_crd.status else "PENDING"
            if status != "DELETE":
                valid_tasks.append(t)

        # Sort by updated_at descending
        valid_tasks.sort(key=lambda t: t.updated_at, reverse=True)

        # Build lightweight result
        result = build_lite_task_list(db, valid_tasks, user_id)

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
            types: List of task types to include. Options: 'online', 'offline', 'subscription'.
                   Default is ['online', 'offline'] if None.

        Performance optimized: Uses application-layer filtering instead of JSON_EXTRACT.
        """
        if types is None:
            types = ["online", "offline"]

        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

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
        """
        )
        member_task_ids_result = db.execute(member_task_ids_sql).fetchall()
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
        except Exception:
            # If validation fails, treat as not found
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

    def _get_bots_for_subtasks(
        self, db: Session, all_bot_ids: set
    ) -> Dict[int, Dict[str, Any]]:
        """Get bot information for subtasks with optimized batch queries."""
        from app.services.readers.kinds import KindType, kindReader

        bots = {}
        if not all_bot_ids:
            return bots

        bot_objects = kindReader.get_by_ids(db, KindType.BOT, list(all_bot_ids))

        if not bot_objects:
            return bots

        # Collect all unique model and shell references for batch queries
        model_refs = []
        shell_refs = []
        bot_id_to_refs = {}

        for bot in bot_objects:
            bot_crd = Bot.model_validate(bot.json)
            bot_id_to_refs[bot.id] = {
                "model_ref": bot_crd.spec.modelRef,
                "shell_ref": bot_crd.spec.shellRef,
                "bot": bot,
                "bot_crd": bot_crd,
            }
            if bot_crd.spec.modelRef:
                model_refs.append(
                    (
                        bot.user_id,
                        bot_crd.spec.modelRef.namespace,
                        bot_crd.spec.modelRef.name,
                    )
                )
            if bot_crd.spec.shellRef:
                shell_refs.append(
                    (
                        bot.user_id,
                        bot_crd.spec.shellRef.namespace,
                        bot_crd.spec.shellRef.name,
                    )
                )

        # Batch query all models and shells
        model_map = {}
        shell_map = {}

        # Query models in batch
        if model_refs:
            # Use a more efficient query approach
            from sqlalchemy import or_

            from app.models.kind import Kind

            # Build conditions to match either owner or public (user_id=0) models
            conditions = []
            for user_id, namespace, name in model_refs:
                # Match either the owner or public models
                conditions.append(
                    (
                        (Kind.user_id.in_([user_id, 0]))
                        & (Kind.kind == KindType.MODEL.value)
                        & (Kind.namespace == namespace)
                        & (Kind.name == name)
                        & (Kind.is_active.is_(True))
                    )
                )

            if conditions:
                models = db.query(Kind).filter(or_(*conditions)).all()
                for model in models:
                    key = (model.user_id, model.namespace, model.name)
                    model_map[key] = model

        # Query shells in batch
        if shell_refs:
            from sqlalchemy import or_

            from app.models.kind import Kind

            # Build conditions to match either owner or public (user_id=0) shells
            conditions = []
            for user_id, namespace, name in shell_refs:
                # Match either the owner or public shells
                conditions.append(
                    (
                        (Kind.user_id.in_([user_id, 0]))
                        & (Kind.kind == KindType.SHELL.value)
                        & (Kind.namespace == namespace)
                        & (Kind.name == name)
                        & (Kind.is_active.is_(True))
                    )
                )

            if conditions:
                shells = db.query(Kind).filter(or_(*conditions)).all()
                for shell in shells:
                    key = (shell.user_id, shell.namespace, shell.name)
                    shell_map[key] = shell

        # Build bot dicts using cached model/shell data
        for bot_id, refs in bot_id_to_refs.items():
            bot = refs["bot"]
            bot_crd = refs["bot_crd"]

            # Initialize default values
            shell_type = ""
            agent_config = {}

            # Get Model data from cache
            if refs["model_ref"]:
                model_key = (
                    bot.user_id,
                    refs["model_ref"].namespace,
                    refs["model_ref"].name,
                )
                model = model_map.get(model_key)
                # Try public fallback if owner lookup misses
                if model is None:
                    public_key = (
                        0,
                        refs["model_ref"].namespace,
                        refs["model_ref"].name,
                    )
                    model = model_map.get(public_key)
                model_type = "public" if model and model.user_id == 0 else "user"
                agent_config = {
                    "bind_model": refs["model_ref"].name,
                    "bind_model_type": model_type,
                }

            # Get Shell data from cache
            if refs["shell_ref"]:
                shell_key = (
                    bot.user_id,
                    refs["shell_ref"].namespace,
                    refs["shell_ref"].name,
                )
                shell = shell_map.get(shell_key)
                # Try public fallback if owner lookup misses
                if shell is None:
                    public_key = (
                        0,
                        refs["shell_ref"].namespace,
                        refs["shell_ref"].name,
                    )
                    shell = shell_map.get(public_key)
                if shell and shell.json:
                    shell_crd = Shell.model_validate(shell.json)
                    shell_type = shell_crd.spec.shellType

            # Note: system_prompt and mcp_servers from Ghost are intentionally excluded
            # from the response to avoid sending sensitive data to the frontend
            # via WebSocket task:join events
            bot_dict = {
                "id": bot.id,
                "user_id": bot.user_id,
                "name": bot.name,
                "shell_type": shell_type,
                "agent_config": agent_config,
                "is_active": bot.is_active,
                "created_at": (bot.created_at.isoformat() if bot.created_at else None),
                "updated_at": (bot.updated_at.isoformat() if bot.updated_at else None),
            }
            bots[bot_id] = bot_dict

        return bots

    def _convert_subtasks_to_dict(
        self, subtasks: List, bots: Dict[int, Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Convert subtasks to dictionary format."""
        subtasks_dict = []
        for subtask in subtasks:
            # Convert contexts to dict format
            contexts_list = []
            if hasattr(subtask, "contexts") and subtask.contexts:
                for ctx in subtask.contexts:
                    ctx_dict = {
                        "id": ctx.id,
                        "context_type": ctx.context_type,
                        "name": ctx.name,
                        "status": (
                            ctx.status.value
                            if hasattr(ctx.status, "value")
                            else ctx.status
                        ),
                    }
                    # Add type-specific fields
                    if ctx.context_type == "attachment":
                        ctx_dict.update(
                            {
                                "file_extension": ctx.file_extension,
                                "file_size": ctx.file_size,
                                "mime_type": ctx.mime_type,
                            }
                        )
                    elif ctx.context_type == "knowledge_base":
                        ctx_dict.update({"document_count": ctx.document_count})
                    elif ctx.context_type == "table":
                        type_data = ctx.type_data or {}
                        url = type_data.get("url")
                        if url:
                            ctx_dict["source_config"] = {"url": url}
                    contexts_list.append(ctx_dict)

            subtask_dict = {
                "id": subtask.id,
                "task_id": subtask.task_id,
                "team_id": subtask.team_id,
                "title": subtask.title,
                "bot_ids": subtask.bot_ids,
                "role": subtask.role,
                "prompt": subtask.prompt,
                "executor_namespace": subtask.executor_namespace,
                "executor_name": subtask.executor_name,
                "message_id": subtask.message_id,
                "parent_id": subtask.parent_id,
                "status": subtask.status,
                "progress": subtask.progress,
                "result": subtask.result,
                "error_message": subtask.error_message,
                "user_id": subtask.user_id,
                "created_at": (
                    subtask.created_at.isoformat() if subtask.created_at else None
                ),
                "updated_at": (
                    subtask.updated_at.isoformat() if subtask.updated_at else None
                ),
                "completed_at": (
                    subtask.completed_at.isoformat() if subtask.completed_at else None
                ),
                "bots": [
                    bots.get(bot_id) for bot_id in subtask.bot_ids if bot_id in bots
                ],
                "contexts": contexts_list,
                "attachments": [],
                "sender_type": subtask.sender_type,
                "sender_user_id": subtask.sender_user_id,
                "sender_user_name": getattr(subtask, "sender_user_name", None),
                "reply_to_subtask_id": subtask.reply_to_subtask_id,
            }
            subtasks_dict.append(subtask_dict)

        return subtasks_dict

    def _add_group_chat_info_to_task(
        self, db: Session, task_id: int, task_dict: Dict[str, Any], user_id: int
    ) -> None:
        """Add group chat information to task dict using ResourceMember."""
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK.value,
                ResourceMember.resource_id == task_id,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        return task_dict

    def get_task_skills(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Dict[str, Any]:
        """Get all skills associated with a task."""
        return resolve_task_skills(db, task_id=task_id, user_id=user_id)
