# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared task-card execution parameters and message source metadata."""

import logging
from copy import deepcopy
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_WEWORK, KIND_TEAM
from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.chat.wework_task_defaults import apply_existing_wework_task_defaults

logger = logging.getLogger(__name__)

IM_SOURCE = "im"
DEFAULT_TASK_TYPE = "chat"


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
