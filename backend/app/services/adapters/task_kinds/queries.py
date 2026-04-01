# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task query methods."""

import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.schemas.kind import Task

from .converters import convert_to_task_dict, convert_to_task_dict_optimized
from .filters import filter_tasks_for_display, filter_tasks_with_title_match
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


class TaskQueryMixin:
    """Mixin class providing task query methods."""

    def get_user_tasks_with_pagination(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (excluding DELETE status).

        Includes tasks owned by user and tasks where user is an approved member.
        """
        task_ids, total = get_accessible_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=limit, extra_limit=50
        )
        if not task_ids:
            return [], total

        tasks = load_tasks_by_ids(db, task_ids)
        id_to_task = filter_tasks_for_display(tasks)
        filtered_tasks = restore_task_order(task_ids, id_to_task, limit)
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
        Get user's Task list with pagination (lightweight list response).

        Includes tasks owned by user and tasks where user is an approved member.
        """
        task_ids, total = get_accessible_task_ids_and_total(
            db, user_id=user_id, skip=skip, limit=limit, extra_limit=50
        )
        if not task_ids:
            return [], total

        tasks = load_tasks_by_ids(db, task_ids)
        id_to_task = filter_tasks_for_display(tasks)
        filtered_tasks = restore_task_order(task_ids, id_to_task, limit)
        if not filtered_tasks:
            return [], total

        result = build_lite_task_list(db, filtered_tasks, user_id)
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

        Allows access if user is owner or approved member.
        """
        from app.services.task_member_service import task_member_service

        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.in_(TaskResource.is_active_query()),
                text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'"),
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(status_code=404, detail="Task not found")

        return convert_to_task_dict(task, db, task.user_id)

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
        add_group_chat_info_to_task(
            db, task_id=task_id, task_dict=task_dict, user_id=user_id
        )
        return task_dict

    def get_task_skills(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Dict[str, Any]:
        """Get all skills associated with a task."""
        return resolve_task_skills(db, task_id=task_id, user_id=user_id)
