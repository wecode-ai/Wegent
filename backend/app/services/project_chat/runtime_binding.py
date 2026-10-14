# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve manually created comment sessions through their durable TaskBinding."""

from dataclasses import dataclass

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import (
    LoopItemExecutionAssignmentStatus,
    ProjectChatCommentExecution,
)


@dataclass(frozen=True)
class BoundCommentSession:
    executor_owner_user_id: int
    runtime_device_id: str
    runtime_task_id: str
    agent_id: str
    id: None = None
    team_id: int = 0
    executor_type: str = "project_robot"
    automation_run_id: str = ""


def resolve_bound_comment_session(
    db: Session,
    request: ProjectChatCommentExecution,
    target: ProjectChatMessage,
) -> BoundCommentSession:
    binding = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.cloud_project_id == request.project_id,
            LoopItemTaskBinding.loop_item_id == request.task_id,
            LoopItemTaskBinding.device_id == target.runtime_device_id,
            LoopItemTaskBinding.task_id == target.runtime_task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
        )
        .one_or_none()
    )
    metadata = target.metadata_json or {}
    if binding is None and metadata.get("activity_type") == "member_execution":
        binding = _register_member_binding(db, request, target)
    if binding is None or not binding.task_user_id or not target.agent_id:
        raise HTTPException(409, "The comment has no valid execution binding")
    return BoundCommentSession(
        executor_owner_user_id=binding.task_user_id,
        runtime_device_id=binding.device_id,
        runtime_task_id=binding.task_id,
        agent_id=target.agent_id,
    )


def _register_member_binding(
    db: Session,
    request: ProjectChatCommentExecution,
    target: ProjectChatMessage,
) -> LoopItemTaskBinding:
    from app.services.collaboration_member_activity import _manager_assignment
    from app.services.collaboration_member_binding import (
        bind_collaboration_member_session,
    )

    metadata = target.metadata_json or {}
    try:
        values = LoopItemExecutionAssignmentStatus(
            loop_item_id=request.task_id,
            dispatch_id=metadata.get("dispatch_id"),
            round_id=metadata.get("coordination_round_id"),
            assignment_id=metadata.get("assignment_id"),
            runtime_device_id=target.runtime_device_id,
            runtime_task_id=target.runtime_task_id,
            status="completed",
        )
    except ValidationError as exc:
        raise HTTPException(
            409, "The member assignment binding is unavailable"
        ) from exc
    manager_assignment = _manager_assignment(
        db, project_id=int(request.project_id), values=values
    )
    if manager_assignment is None:
        raise HTTPException(409, "The member assignment binding is unavailable")
    _, assignment, _ = manager_assignment
    if assignment.get("agent_id") != target.agent_id:
        raise HTTPException(409, "The member session does not match its assignment")
    return bind_collaboration_member_session(
        db, project_id=int(request.project_id), values=values, assignment=assignment
    )
