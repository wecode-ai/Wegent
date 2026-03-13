# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared query utilities for task list endpoints."""

import logging
from time import perf_counter
from typing import Dict, List, Optional, Set, Tuple

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.models.task import TaskResource

logger = logging.getLogger(__name__)

_ACCESSIBLE_COUNT_SQL = text(
    """
    SELECT COUNT(DISTINCT k.id)
    FROM tasks k
    LEFT JOIN resource_members tm ON k.id = tm.resource_id
        AND tm.resource_type = 'Task'
        AND tm.user_id = :user_id
        AND tm.status = 'approved'
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND (k.user_id = :user_id OR tm.id IS NOT NULL)
"""
)

_ACCESSIBLE_IDS_SQL = text(
    """
    SELECT DISTINCT k.id, k.created_at
    FROM tasks k
    LEFT JOIN resource_members tm ON k.id = tm.resource_id
        AND tm.resource_type = 'Task'
        AND tm.user_id = :user_id
        AND tm.status = 'approved'
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND (k.user_id = :user_id OR tm.id IS NOT NULL)
    ORDER BY k.created_at DESC
    LIMIT :limit OFFSET :skip
"""
)

_OWNED_COUNT_SQL = text(
    """
    SELECT COUNT(*)
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
"""
)

_OWNED_IDS_SQL = text(
    """
    SELECT k.id, k.created_at
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    ORDER BY k.created_at DESC
    LIMIT :limit OFFSET :skip
"""
)

_GROUP_BY_MEMBERS_FOR_ACCESSIBLE_SQL = text(
    """
    SELECT DISTINCT tm.resource_id
    FROM resource_members tm
    INNER JOIN tasks k ON k.id = tm.resource_id AND tm.resource_type = 'Task'
    WHERE tm.status = 'approved'
    AND k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND (k.user_id = :user_id OR tm.user_id = :user_id)
    AND tm.copied_resource_id = 0
"""
)

_GROUP_BY_MEMBERS_FOR_OWNED_SQL = text(
    """
    SELECT DISTINCT tm.resource_id
    FROM resource_members tm
    INNER JOIN tasks k ON k.id = tm.resource_id AND tm.resource_type = 'Task'
    WHERE tm.status = 'approved'
    AND k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND tm.copied_resource_id = 0
"""
)

_EXPLICIT_GROUP_FOR_ACCESSIBLE_SQL = text(
    """
    SELECT DISTINCT k.id
    FROM tasks k
    LEFT JOIN resource_members tm ON k.id = tm.resource_id
        AND tm.resource_type = 'Task'
        AND tm.user_id = :user_id
        AND tm.status = 'approved'
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND (k.user_id = :user_id OR tm.id IS NOT NULL)
    AND k.is_group_chat = true
"""
)

_EXPLICIT_GROUP_FOR_OWNED_SQL = text(
    """
    SELECT DISTINCT k.id
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = true
"""
)


def _timed_scalar(
    db: Session, sql: object, params: Dict[str, object], query_name: str
) -> int:
    started_at = perf_counter()
    value = db.execute(sql, params).scalar()
    elapsed_ms = (perf_counter() - started_at) * 1000
    logger.debug("[task_query:%s] scalar elapsed_ms=%.2f", query_name, elapsed_ms)
    return int(value or 0)


def _timed_rows(
    db: Session, sql: object, params: Dict[str, object], query_name: str
) -> List:
    started_at = perf_counter()
    rows = db.execute(sql, params).fetchall()
    elapsed_ms = (perf_counter() - started_at) * 1000
    logger.debug(
        "[task_query:%s] rows=%s elapsed_ms=%.2f",
        query_name,
        len(rows),
        elapsed_ms,
    )
    return rows


def get_accessible_task_ids_and_total(
    db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
) -> Tuple[List[int], int]:
    """Fetch accessible task IDs (owner or member) and total count."""
    total = _timed_scalar(
        db,
        _ACCESSIBLE_COUNT_SQL,
        {"user_id": user_id, "is_active": TaskResource.STATE_ACTIVE},
        "accessible_total",
    )
    rows = _timed_rows(
        db,
        _ACCESSIBLE_IDS_SQL,
        {
            "user_id": user_id,
            "is_active": TaskResource.STATE_ACTIVE,
            "limit": limit + extra_limit,
            "skip": skip,
        },
        "accessible_ids",
    )
    task_ids = [row[0] for row in rows]
    return task_ids, total


def get_owned_task_ids_and_total(
    db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
) -> Tuple[List[int], int]:
    """Fetch owned task IDs and total count."""
    total = _timed_scalar(
        db,
        _OWNED_COUNT_SQL,
        {"user_id": user_id, "is_active": TaskResource.STATE_ACTIVE},
        "owned_total",
    )
    rows = _timed_rows(
        db,
        _OWNED_IDS_SQL,
        {
            "user_id": user_id,
            "is_active": TaskResource.STATE_ACTIVE,
            "limit": limit + extra_limit,
            "skip": skip,
        },
        "owned_ids",
    )
    task_ids = [row[0] for row in rows]
    return task_ids, total


def _get_group_task_ids_by_membership(
    db: Session, *, user_id: int, only_owned: bool
) -> Set[int]:
    sql = (
        _GROUP_BY_MEMBERS_FOR_OWNED_SQL
        if only_owned
        else _GROUP_BY_MEMBERS_FOR_ACCESSIBLE_SQL
    )
    rows = _timed_rows(
        db,
        sql,
        {"user_id": user_id, "is_active": TaskResource.STATE_ACTIVE},
        "group_member_ids_owned" if only_owned else "group_member_ids_accessible",
    )
    return {row[0] for row in rows}


def _get_explicit_group_task_ids(
    db: Session, *, user_id: int, only_owned: bool
) -> Set[int]:
    sql = (
        _EXPLICIT_GROUP_FOR_OWNED_SQL
        if only_owned
        else _EXPLICIT_GROUP_FOR_ACCESSIBLE_SQL
    )
    rows = _timed_rows(
        db,
        sql,
        {"user_id": user_id, "is_active": TaskResource.STATE_ACTIVE},
        "explicit_group_ids_owned" if only_owned else "explicit_group_ids_accessible",
    )
    return {row[0] for row in rows}


def get_group_task_ids_for_accessible_user(db: Session, *, user_id: int) -> Set[int]:
    """Return all accessible group task IDs for a user."""
    return _get_group_task_ids_by_membership(
        db, user_id=user_id, only_owned=False
    ) | _get_explicit_group_task_ids(db, user_id=user_id, only_owned=False)


def get_group_task_ids_for_owned_tasks(db: Session, *, user_id: int) -> Set[int]:
    """Return group task IDs that belong to the owner's task set."""
    return _get_group_task_ids_by_membership(
        db, user_id=user_id, only_owned=True
    ) | _get_explicit_group_task_ids(db, user_id=user_id, only_owned=True)


def load_tasks_by_ids(db: Session, task_ids: List[int]) -> List[TaskResource]:
    """Load task resources by IDs."""
    if not task_ids:
        return []
    return db.query(TaskResource).filter(TaskResource.id.in_(task_ids)).all()


def count_non_deleted_tasks_by_ids(db: Session, task_ids: List[int]) -> int:
    """Count non-deleted tasks within ID set."""
    if not task_ids:
        return 0
    count_value = (
        db.query(func.count(TaskResource.id))
        .filter(
            TaskResource.id.in_(task_ids),
            text(
                "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')), '') != 'DELETE'"
            ),
        )
        .scalar()
    )
    return int(count_value or 0)


def load_tasks_by_ids_ordered(
    db: Session,
    task_ids: List[int],
    *,
    order_field: str = "updated_at",
    descending: bool = True,
    skip: int = 0,
    limit: Optional[int] = None,
    exclude_deleted: bool = False,
) -> List[TaskResource]:
    """Load tasks by IDs with ordering and optional pagination/filtering."""
    if not task_ids:
        return []

    if order_field not in {"id", "created_at", "updated_at"}:
        raise ValueError(f"Unsupported order_field: {order_field}")

    query = db.query(TaskResource).filter(TaskResource.id.in_(task_ids))
    if exclude_deleted:
        query = query.filter(
            text(
                "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')), '') != 'DELETE'"
            )
        )

    order_column = getattr(TaskResource, order_field)
    query = query.order_by(order_column.desc() if descending else order_column.asc())

    if skip:
        query = query.offset(skip)
    if limit is not None:
        query = query.limit(limit)

    return query.all()


def restore_task_order(
    task_ids: List[int], id_to_task: Dict[int, TaskResource], limit: int
) -> List[TaskResource]:
    """Restore database ID ordering after in-memory filtering."""
    ordered_tasks: List[TaskResource] = []
    for task_id in task_ids:
        if task_id in id_to_task:
            ordered_tasks.append(id_to_task[task_id])
            if len(ordered_tasks) >= limit:
                break
    return ordered_tasks
