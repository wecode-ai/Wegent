# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Filter owned task titles before selecting a page of task IDs."""

from sqlalchemy import desc, func, or_
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
    sources: list[tuple[type, Query]] | None = None,
) -> tuple[list[int], int]:
    """Count all visible matches and hydrate only the requested page later."""
    sources = (
        sources if sources is not None else [(TaskResource, db.query(TaskResource))]
    )
    queries = [
        _owned_title_query(query, model, user_id=user_id, title=title).with_entities(
            model.id.label("id"), model.created_at.label("created_at")
        )
        for model, query in sources
    ]
    query = queries[0].union_all(*queries[1:]) if len(queries) > 1 else queries[0]
    total = query.order_by(None).count()
    rows = (
        query.order_by(desc("created_at"), desc("id")).offset(skip).limit(limit).all()
    )
    return [row.id for row in rows], total


def _owned_title_query(query: Query, model: type, *, user_id: int, title: str) -> Query:
    document = model.json
    status = document[("status", "status")].as_string()
    task_type = document[("metadata", "labels", "type")].as_string()
    interacted = document[("metadata", "labels", "userInteracted")].as_string()
    query = query.filter(
        model.kind == "Task",
        model.user_id == user_id,
        model.is_active == TaskResource.STATE_ACTIVE,
        model.namespace != "system",
        func.coalesce(status, "") != "DELETE",
        or_(
            func.coalesce(task_type, "") != "subscription",
            interacted == "true",
        ),
    )
    return filter_tasks_by_title(query, model=model, title=title)


def filter_tasks_by_title(
    query: Query,
    *,
    title: str,
    use_name_fallback: bool = False,
    model: type = TaskResource,
) -> Query:
    """Match title keywords literally without loading task JSON documents."""
    task_title = model.json[("spec", "title")].as_string()
    if use_name_fallback:
        task_title = func.coalesce(func.nullif(task_title, ""), model.name)
    return query.filter(
        func.lower(func.coalesce(task_title, "")).contains(
            title.lower(), autoescape=True
        )
    )
