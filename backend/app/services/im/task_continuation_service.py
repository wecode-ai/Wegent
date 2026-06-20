# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend helpers for continuing WeWork private IM conversations in tasks."""

import logging
from copy import deepcopy
from typing import Any, Sequence

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_WEWORK, KIND_TEAM
from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.models.project import Project
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.chat.storage.task_manager import (
    TaskCreationParams,
    TaskCreationResult,
    create_chat_task,
)
from app.services.chat.wework_task_defaults import (
    apply_existing_wework_task_defaults,
    apply_wework_task_defaults,
)
from app.services.im.session_service import im_session_service
from app.stores.tasks import task_store

logger = logging.getLogger(__name__)

IM_SOURCE = "im"
DEFAULT_TASK_TYPE = "chat"


def validate_personal_wework_task(
    db: Session,
    user_id: int,
    task_id: int,
) -> TaskResource:
    """Return an active owner-only WeWork personal task or raise HTTP errors."""

    task = task_store.get_task_by_states(
        db,
        task_id=task_id,
        states=[TaskResource.STATE_ACTIVE],
        kind="Task",
        user_id=user_id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )

    if task.is_group_chat:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only personal WeWork tasks can be bound to private IM sessions",
        )

    if _has_approved_task_members(db, task.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Shared tasks cannot be bound to private IM sessions",
        )

    return task


async def bind_task_to_sessions(
    db: Session,
    user_id: int,
    task_id: int,
    session_keys: Sequence[str],
) -> list[str]:
    """Bind current user's private IM sessions to a validated WeWork task."""

    task = validate_personal_wework_task(db, user_id, task_id)
    sessions = await load_user_private_sessions_by_keys(
        db,
        user_id=user_id,
        session_keys=session_keys,
    )
    for session in sessions:
        await im_session_service.bind_active_task(db, session=session, task_id=task.id)
    return [str(session_key) for session_key in session_keys]


async def load_user_private_sessions_by_keys(
    db: Session,
    *,
    user_id: int,
    session_keys: Sequence[str],
) -> list[IMPrivateSession]:
    """Load current user's private sessions and preserve caller order."""

    return await im_session_service.load_user_sessions_by_keys(
        db,
        user_id=user_id,
        session_keys=session_keys,
    )


def list_recent_wework_tasks(
    db: Session,
    user_id: int,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """List recent active personal WeWork tasks for private IM switching."""

    tasks = task_store.list_recent_owner_only_tasks(
        db,
        user_id=user_id,
        client_origin=CLIENT_ORIGIN_WEWORK,
        limit=limit,
    )
    return [{"id": task.id, "title": get_task_title(task)} for task in tasks]


def list_wework_projects(
    db: Session,
    user_id: int,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """List active WeWork projects for private IM task creation."""

    projects = (
        db.query(Project)
        .filter(
            Project.user_id == user_id,
            Project.client_origin == CLIENT_ORIGIN_WEWORK,
            Project.is_active == True,
        )
        .order_by(Project.updated_at.desc(), Project.id.desc())
        .limit(limit)
        .all()
    )
    return [{"id": project.id, "name": project.name} for project in projects]


def get_task_title(task: TaskResource) -> str:
    """Return the user-facing task title from the Task CRD."""

    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
    title = str(spec.get("title") or "").strip()
    if title:
        return title
    return task.name or f"Task {task.id}"


def get_task_team(db: Session, task: TaskResource) -> Kind:
    """Resolve the Team Kind referenced by a Task CRD."""

    try:
        task_crd = Task.model_validate(task.json)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid task CRD",
        ) from exc

    team_ref = task_crd.spec.teamRef
    team_user_id = team_ref.user_id if team_ref.user_id is not None else task.user_id
    team = (
        db.query(Kind)
        .filter(
            Kind.kind == KIND_TEAM,
            Kind.namespace == team_ref.namespace,
            Kind.name == team_ref.name,
            Kind.user_id == team_user_id,
            Kind.is_active == True,
        )
        .first()
    )
    if team is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task team not found",
        )
    return team


def build_im_message_source(
    session: IMPrivateSession,
    *,
    message_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build persisted source metadata for a private IM message."""

    source: dict[str, Any] = {
        "source": IM_SOURCE,
        "session_key": session.session_key,
        "channel_type": session.channel_type,
        "channel_id": session.channel_id,
        "conversation_id": session.conversation_id,
        "sender_id": session.sender_id,
    }
    if message_id:
        source["message_id"] = message_id
    if extra:
        source.update(extra)
    return source


def build_existing_task_params(
    task: TaskResource,
    *,
    message: str,
    message_source: dict[str, Any] | None,
) -> TaskCreationParams:
    """Build TaskCreationParams for appending an IM message to an existing task."""

    params = TaskCreationParams(
        message=message,
        title=get_task_title(task),
        task_type=_get_task_type(task),
        is_group_chat=False,
        project_id=task.project_id or None,
        client_origin=CLIENT_ORIGIN_WEWORK,
        source=IM_SOURCE,
        message_source=deepcopy(message_source) if message_source is not None else None,
    )
    return apply_existing_wework_task_defaults(params=params, task=task)


async def resolve_existing_task_params(
    db: Session,
    *,
    user: User,
    task: TaskResource,
    message: str,
    message_source: dict[str, Any] | None,
) -> TaskCreationParams:
    """Build and enrich TaskCreationParams for an existing Wework IM task."""

    params = build_existing_task_params(
        task,
        message=message,
        message_source=message_source,
    )
    return params


async def build_new_task_params(
    db: Session,
    *,
    user: User,
    message: str,
    title: str | None = None,
    project_id: int | None = None,
    task_type: str | None = None,
    message_source: dict[str, Any] | None = None,
) -> TaskCreationParams:
    """Build TaskCreationParams for creating a personal WeWork task from IM."""

    params = TaskCreationParams(
        message=message,
        title=title,
        task_type=task_type or DEFAULT_TASK_TYPE,
        is_group_chat=False,
        project_id=project_id,
        client_origin=CLIENT_ORIGIN_WEWORK,
        source=IM_SOURCE,
        message_source=deepcopy(message_source) if message_source is not None else None,
    )
    return await apply_wework_task_defaults(db, user=user, params=params)


async def append_message_to_task(
    db: Session,
    *,
    user: User,
    task_id: int,
    message: str,
    message_source: dict[str, Any] | None,
) -> TaskCreationResult:
    """Append a private IM message to an existing WeWork task and trigger AI."""

    task = validate_personal_wework_task(db, user.id, task_id)
    team = get_task_team(db, task)
    task_params = await resolve_existing_task_params(
        db,
        user=user,
        task=task,
        message=message,
        message_source=message_source,
    )
    result = await create_chat_task(
        db=db,
        user=user,
        team=team,
        message=message,
        params=task_params,
        task_id=task.id,
        should_trigger_ai=True,
        source=IM_SOURCE,
    )
    setattr(result, "task_params", task_params)
    return result


def _has_approved_task_members(db: Session, task_id: int) -> bool:
    return (
        db.query(ResourceMember.id)
        .filter(
            ResourceMember.resource_type == ResourceType.TASK.value,
            ResourceMember.resource_id == task_id,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .first()
        is not None
    )


def _get_task_type(task: TaskResource) -> str:
    task_json = task.json if isinstance(task.json, dict) else {}
    metadata = (
        task_json.get("metadata") if isinstance(task_json.get("metadata"), dict) else {}
    )
    labels = metadata.get("labels") if isinstance(metadata.get("labels"), dict) else {}
    return (
        str(labels.get("taskType") or labels.get("type") or DEFAULT_TASK_TYPE).strip()
        or DEFAULT_TASK_TYPE
    )
