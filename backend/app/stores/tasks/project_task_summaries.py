# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project task list reads that avoid loading full task JSON documents."""

from datetime import datetime
from typing import Literal

from sqlalchemy import and_, or_
from sqlalchemy.engine import Row
from sqlalchemy.orm import Query

from app.models.task import TaskResource
from app.stores.tasks.interfaces import ProjectTaskSummary
from shared.telemetry.decorators import trace_sync


@trace_sync("list_project_task_summaries", "tasks.store")
def list_project_task_summaries(
    query: Query,
    *,
    model: type = TaskResource,
    skip: int = 0,
    limit: int | None = None,
    before: tuple[datetime, int] | None = None,
    sort_by: Literal["updated_at", "created_at"] = "updated_at",
) -> list[ProjectTaskSummary]:
    """Preserve JSON value types while selecting only individual list fields."""
    if before is not None:
        if sort_by != "created_at":
            raise ValueError("Project task cursors require created_at ordering")
        created_at, task_id = before
        query = query.filter(
            or_(
                model.created_at < created_at,
                and_(model.created_at == created_at, model.id < task_id),
            )
        )
    query = query.order_by(getattr(model, sort_by).desc(), model.id.desc())
    if limit is not None:
        query = query.limit(limit)
    if skip:
        query = query.offset(skip)
    rows = query.with_entities(
        model.id,
        model.name,
        model.project_id,
        model.created_at,
        model.updated_at,
        model.json[("spec", "title")].label("title"),
        model.json[("spec", "device_id")].label("device_id"),
        model.json[("spec", "is_group_chat")].label("is_group_chat"),
        model.json[("spec", "execution", "workspace", "source")].label(
            "workspace_source"
        ),
        model.json[("spec", "execution", "workspace", "path")].label("workspace_path"),
        model.json[("status", "status")].label("status"),
    ).all()
    return [_project_task_summary(row) for row in rows]


def _project_task_summary(row: Row) -> ProjectTaskSummary:
    spec = {
        key: value
        for key, value in {
            "title": row.title,
            "device_id": row.device_id,
            "is_group_chat": row.is_group_chat,
        }.items()
        if value is not None
    }
    workspace = {
        key: value
        for key, value in {
            "source": row.workspace_source,
            "path": row.workspace_path,
        }.items()
        if value is not None
    }
    if workspace:
        spec["execution"] = {"workspace": workspace}
    status = {"status": row.status} if row.status is not None else {}
    return ProjectTaskSummary(
        id=row.id,
        name=row.name,
        project_id=row.project_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
        json={"spec": spec, "status": status},
    )
