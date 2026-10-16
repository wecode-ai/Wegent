# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project read permissions and bounded task queries."""

import base64
import binascii
import json
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import exists, or_
from sqlalchemy.orm import Query, Session

from app.models.project import Project
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.schemas.project import ProjectTaskListResponse, ProjectTaskResponse
from app.services.task_execution_workspace import (
    task_execution_workspace_path,
    task_execution_workspace_source,
)
from app.stores.tasks import task_store
from app.stores.tasks.interfaces import ProjectTaskSummary
from shared.telemetry.decorators import trace_sync


def readable_projects_query(
    db: Session, *, user_id: int, client_origin: Optional[str] = None
) -> Query:
    """Scope projects to their owner or an approved shared-project reader."""
    shared_project = exists().where(
        ResourceMember.resource_type == ResourceType.PROJECT.value,
        ResourceMember.resource_id == Project.id,
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(user_id),
        ResourceMember.status == MemberStatus.APPROVED.value,
    )
    query = db.query(Project).filter(
        or_(Project.user_id == user_id, shared_project),
        Project.is_active == True,
    )
    if client_origin:
        query = query.filter(Project.client_origin == client_origin)
    return query


@trace_sync("projects.tasks.list_page", "backend.projects")
def list_project_tasks(
    db: Session,
    *,
    project_id: int,
    user_id: int,
    page: int = 1,
    limit: int = 50,
    cursor: Optional[str] = None,
    client_origin: Optional[str] = None,
    title: Optional[str] = None,
) -> ProjectTaskListResponse:
    """Return one page without materializing other project tasks."""
    before = _decode_task_cursor(cursor) if cursor is not None else None
    project = (
        readable_projects_query(db, user_id=user_id, client_origin=client_origin)
        .filter(Project.id == project_id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    total = task_store.count_active_project_tasks(
        db,
        project_id=project.id,
        owner_user_id=project.user_id,
        client_origin=client_origin,
        title=title,
    )
    skip = 0 if before is not None else (page - 1) * limit
    if before is None and skip >= total:
        return ProjectTaskListResponse(total=total, items=[], has_more=False)
    tasks = task_store.list_active_project_tasks(
        db,
        project_id=project.id,
        owner_user_id=project.user_id,
        client_origin=client_origin,
        skip=skip,
        limit=limit + 1,
        before=before,
        title=title,
        sort_by="created_at",
    )
    has_more = len(tasks) > limit
    tasks = tasks[:limit]
    return ProjectTaskListResponse(
        total=total,
        items=[project_task_response(task) for task in tasks],
        has_more=has_more,
        next_cursor=_encode_task_cursor(tasks[-1]) if has_more else None,
    )


def _encode_task_cursor(task: TaskResource | ProjectTaskSummary) -> str:
    payload = json.dumps(
        {"created_at": task.created_at.isoformat(), "id": task.id},
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_task_cursor(cursor: str) -> tuple[datetime, int]:
    """Decode an immutable ordering key without looking up its task."""
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(
            base64.b64decode(cursor + padding, altchars=b"-_", validate=True)
        )
        if not isinstance(payload, dict) or set(payload) != {"created_at", "id"}:
            raise ValueError("Unexpected cursor fields")
        created_at = datetime.fromisoformat(payload["created_at"])
        task_id = payload["id"]
        if (
            created_at.tzinfo is not None
            or created_at.year < 1000
            or created_at.isoformat() != payload["created_at"]
            or type(task_id) is not int
            or not 0 < task_id <= 2**63 - 1
        ):
            raise ValueError("Invalid task ordering key")
    except (binascii.Error, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid task cursor") from exc
    return created_at, task_id


def project_task_response(
    task: TaskResource | ProjectTaskSummary,
) -> ProjectTaskResponse:
    """Use the same task projection for full lists and individual pages."""
    spec = _task_spec(task)
    return ProjectTaskResponse(
        task_id=task.id,
        task_title=_task_title(task),
        task_status=_task_status(task),
        device_id=spec.get("device_id"),
        execution_workspace_source=task_execution_workspace_source(task),
        execution_workspace_path=task_execution_workspace_path(task),
        is_group_chat=spec.get("is_group_chat", False),
        project_id=task.project_id,
        updated_at=task.updated_at,
    )


def _get_project_tasks(
    db: Session,
    project_id: int,
    *,
    owner_user_id: int,
    client_origin: Optional[str] = None,
) -> list[ProjectTaskResponse]:
    tasks = task_store.list_active_project_tasks(
        db,
        project_id=project_id,
        owner_user_id=owner_user_id,
        client_origin=client_origin,
    )
    return [project_task_response(task) for task in tasks]


def _task_json(task: TaskResource | ProjectTaskSummary) -> dict[str, Any]:
    task_json = task.json or {}
    return task_json if isinstance(task_json, dict) else {}


def _task_spec(task: TaskResource | ProjectTaskSummary) -> dict[str, Any]:
    spec = _task_json(task).get("spec")
    return spec if isinstance(spec, dict) else {}


def _task_title(task: TaskResource | ProjectTaskSummary) -> str:
    return str(_task_spec(task).get("title") or task.name or f"Task #{task.id}")


def _task_status(task: TaskResource | ProjectTaskSummary) -> str:
    status = _task_json(task).get("status")
    if not isinstance(status, dict):
        return "PENDING"
    return str(status.get("status") or "PENDING")
