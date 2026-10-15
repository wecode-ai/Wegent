# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Filter owned task titles before selecting a page of task IDs."""

from sqlalchemy import func, or_
from sqlalchemy.orm import Query, Session

from app.models.task import TaskResource
from shared.telemetry.decorators import trace_sync


@trace_sync("search_owned_task_ids_by_title", "tasks.store")
def search_owned_task_ids_by_title(
    db: Session,
    *,
    user_id: int,
    title: str,
    skip: int,
    limit: int,
) -> tuple[list[int], int]:
    """Count all visible matches and hydrate only the requested page later."""
    document = TaskResource.json
    status = document[("status", "status")].as_string()
    task_type = document[("metadata", "labels", "type")].as_string()
    interacted = document[("metadata", "labels", "userInteracted")].as_string()
    query = db.query(TaskResource.id).filter(
        TaskResource.kind == "Task",
        TaskResource.user_id == user_id,
        TaskResource.is_active == TaskResource.STATE_ACTIVE,
        TaskResource.namespace != "system",
        func.coalesce(status, "") != "DELETE",
        or_(
            func.coalesce(task_type, "") != "subscription",
            interacted == "true",
        ),
    )
    query = filter_tasks_by_title(query, title=title)
    total = query.count()
    rows = (
        query.order_by(TaskResource.created_at.desc(), TaskResource.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return [row.id for row in rows], total


def filter_tasks_by_title(
    query: Query, *, title: str, use_name_fallback: bool = False
) -> Query:
    """Match title keywords literally without loading task JSON documents."""
    task_title = TaskResource.json[("spec", "title")].as_string()
    if use_name_fallback:
        task_title = func.coalesce(func.nullif(task_title, ""), TaskResource.name)
    return query.filter(
        func.lower(func.coalesce(task_title, "")).contains(
            title.lower(), autoescape=True
        )
    )
