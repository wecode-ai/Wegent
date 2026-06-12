# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Compatibility wrappers for task list helpers.

TaskResource SQL lives in app.stores.tasks.SqlAlchemyTaskStore.
"""

from typing import Dict, List, Optional, Set, Tuple

from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.stores.tasks import task_store


def get_accessible_task_ids_and_total(
    db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
) -> Tuple[List[int], int]:
    return task_store.list_accessible_task_ids(
        db, user_id=user_id, skip=skip, limit=limit, extra_limit=extra_limit
    )


def get_owned_task_ids_and_total(
    db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
) -> Tuple[List[int], int]:
    return task_store.list_owned_task_ids(
        db, user_id=user_id, skip=skip, limit=limit, extra_limit=extra_limit
    )


def get_personal_task_ids_and_total(
    db: Session,
    *,
    user_id: int,
    skip: int,
    limit: int,
    extra_limit: int,
    client_origin: Optional[str] = None,
) -> Tuple[List[int], int]:
    return task_store.list_personal_task_ids(
        db,
        user_id=user_id,
        skip=skip,
        limit=limit,
        extra_limit=extra_limit,
        client_origin=client_origin,
    )


def get_group_task_ids_for_accessible_user(db: Session, *, user_id: int) -> Set[int]:
    return task_store.list_group_task_ids_for_accessible_user(db, user_id=user_id)


def get_group_task_ids_for_owned_tasks(db: Session, *, user_id: int) -> Set[int]:
    return task_store.list_group_task_ids_for_owned_tasks(db, user_id=user_id)


def load_tasks_by_ids(db: Session, task_ids: List[int]) -> List[TaskResource]:
    return task_store.list_by_ids(db, task_ids=task_ids)


def count_non_deleted_tasks_by_ids(db: Session, task_ids: List[int]) -> int:
    return task_store.count_non_deleted_by_ids(db, task_ids=task_ids)


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
    return task_store.list_by_ids_ordered(
        db,
        task_ids=task_ids,
        order_field=order_field,
        descending=descending,
        skip=skip,
        limit=limit,
        exclude_deleted=exclude_deleted,
    )


def restore_task_order(
    task_ids: List[int], id_to_task: Dict[int, TaskResource], limit: int
) -> List[TaskResource]:
    ordered_tasks: List[TaskResource] = []
    for task_id in task_ids:
        if task_id in id_to_task:
            ordered_tasks.append(id_to_task[task_id])
            if len(ordered_tasks) >= limit:
                break
    return ordered_tasks
