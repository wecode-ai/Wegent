# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project task list reads that avoid loading full task JSON documents."""

from sqlalchemy.engine import Row
from sqlalchemy.orm import Query

from app.models.task import TaskResource
from app.stores.tasks.interfaces import ProjectTaskSummary
from shared.telemetry.decorators import trace_sync


@trace_sync("list_project_task_summaries", "tasks.store")
def list_project_task_summaries(query: Query) -> list[ProjectTaskSummary]:
    """Preserve JSON value types while selecting only individual list fields."""
    rows = query.with_entities(
        TaskResource.id,
        TaskResource.name,
        TaskResource.project_id,
        TaskResource.created_at,
        TaskResource.updated_at,
        TaskResource.json[("spec", "title")].label("title"),
        TaskResource.json[("spec", "device_id")].label("device_id"),
        TaskResource.json[("spec", "is_group_chat")].label("is_group_chat"),
        TaskResource.json[("spec", "execution", "workspace", "source")].label(
            "workspace_source"
        ),
        TaskResource.json[("spec", "execution", "workspace", "path")].label(
            "workspace_path"
        ),
        TaskResource.json[("status", "status")].label("status"),
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
