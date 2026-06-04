# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""WeWork-specific conversation search service."""

import json
from typing import Any, Dict, List, Tuple

from sqlalchemy import String, cast, or_
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.adapters.task_kinds.converters import convert_to_task_dict_optimized
from app.services.adapters.task_kinds.filters import filter_tasks_for_display
from app.services.adapters.task_kinds.helpers import get_tasks_related_data_batch
from app.services.adapters.task_kinds.query_utils import restore_task_order

SEARCH_RESULT_FALLBACK_TASK_LIMIT = 300
SEARCH_RESULT_FALLBACK_SUBTASK_LIMIT = 1000


def _stringify_search_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _get_subtask_search_text(subtask: Subtask) -> str:
    return "\n".join(
        [
            _stringify_search_value(subtask.prompt),
            _stringify_search_value(subtask.result),
            _stringify_search_value(subtask.error_message),
        ]
    )


def search_wework_conversation_tasks(
    *,
    db: Session,
    user_id: int,
    keyword: str,
    skip: int = 0,
    limit: int = 100,
    client_origin: str = CLIENT_ORIGIN_WEWORK,
) -> Tuple[List[Dict[str, Any]], int]:
    """Search WeWork-owned tasks by title or conversation content."""
    keyword = keyword.strip()
    if not keyword:
        return [], 0

    task_ids, visible_task_by_id = _load_visible_wework_tasks(
        db=db,
        user_id=user_id,
        client_origin=client_origin,
    )
    if not task_ids:
        return [], 0

    matched_task_ids, ordered_matched_task_ids = _collect_matched_task_ids(
        db=db,
        task_ids=task_ids,
        visible_task_by_id=visible_task_by_id,
        keyword=keyword,
        required_count=skip + limit,
    )
    id_to_task = {
        task_id: visible_task_by_id[task_id]
        for task_id in matched_task_ids
        if task_id in visible_task_by_id
    }
    total = len(id_to_task)
    filtered_tasks = restore_task_order(
        ordered_matched_task_ids[skip : skip + limit], id_to_task, limit
    )
    if not filtered_tasks:
        return [], total

    return _format_task_results(db, filtered_tasks, user_id), total


def _collect_matched_task_ids(
    *,
    db: Session,
    task_ids: List[int],
    visible_task_by_id: Dict[int, TaskResource],
    keyword: str,
    required_count: int,
) -> Tuple[set[int], List[int]]:
    keyword_lower = keyword.lower()
    matched_task_ids = _match_task_titles(visible_task_by_id, keyword_lower)
    matched_task_ids.update(_match_subtasks_in_database(db, task_ids, keyword))
    ordered_matched_task_ids = [
        task_id for task_id in task_ids if task_id in matched_task_ids
    ]

    if len(ordered_matched_task_ids) < required_count:
        matched_task_ids.update(
            _match_subtasks_with_python_fallback(
                db=db,
                task_ids=task_ids,
                matched_task_ids=matched_task_ids,
                keyword_lower=keyword_lower,
            )
        )
        ordered_matched_task_ids = [
            task_id for task_id in task_ids if task_id in matched_task_ids
        ]

    return matched_task_ids, ordered_matched_task_ids


def _load_visible_wework_tasks(
    *,
    db: Session,
    user_id: int,
    client_origin: str,
) -> Tuple[List[int], Dict[int, TaskResource]]:
    tasks = (
        db.query(TaskResource)
        .filter(
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
            TaskResource.namespace != "system",
            TaskResource.user_id == user_id,
            TaskResource.client_origin == client_origin,
        )
        .order_by(TaskResource.updated_at.desc())
        .all()
    )
    visible_task_by_id = filter_tasks_for_display(tasks)
    task_ids = [task.id for task in tasks if task.id in visible_task_by_id]
    return task_ids, visible_task_by_id


def _format_task_results(
    db: Session,
    filtered_tasks: List[TaskResource],
    user_id: int,
) -> List[Dict[str, Any]]:
    related_data_batch = get_tasks_related_data_batch(db, filtered_tasks, user_id)
    result = []
    for task in filtered_tasks:
        task_crd = Task.model_validate(task.json)
        task_related_data = related_data_batch.get(str(task.id), {})
        result.append(convert_to_task_dict_optimized(task, task_related_data, task_crd))

    return result


def _match_task_titles(
    visible_task_by_id: Dict[int, TaskResource],
    keyword_lower: str,
) -> set[int]:
    return {
        task.id
        for task in visible_task_by_id.values()
        if keyword_lower in (Task.model_validate(task.json).spec.title or "").lower()
    }


def _match_subtasks_in_database(
    db: Session,
    task_ids: List[int],
    keyword: str,
) -> set[int]:
    like_pattern = f"%{keyword}%"
    rows = (
        db.query(Subtask.task_id)
        .filter(Subtask.task_id.in_(task_ids))
        .filter(
            or_(
                Subtask.prompt.ilike(like_pattern),
                Subtask.error_message.ilike(like_pattern),
                cast(Subtask.result, String).ilike(like_pattern),
            )
        )
        .distinct()
        .all()
    )
    return {row[0] for row in rows}


def _match_subtasks_with_python_fallback(
    *,
    db: Session,
    task_ids: List[int],
    matched_task_ids: set[int],
    keyword_lower: str,
) -> set[int]:
    fallback_task_ids = [
        task_id
        for task_id in task_ids[:SEARCH_RESULT_FALLBACK_TASK_LIMIT]
        if task_id not in matched_task_ids
    ]
    if not fallback_task_ids:
        return set()

    subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id.in_(fallback_task_ids))
        .order_by(Subtask.updated_at.desc())
        .limit(SEARCH_RESULT_FALLBACK_SUBTASK_LIMIT)
        .all()
    )
    return {
        subtask.task_id
        for subtask in subtasks
        if keyword_lower in _get_subtask_search_text(subtask).lower()
    }
