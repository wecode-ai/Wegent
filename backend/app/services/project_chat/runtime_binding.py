# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve comment and group sessions through durable Issue identities."""

from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    LoopItemTaskBinding,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
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
    execution_environment: str = ""
    runtime_selection: dict[str, Any] = field(default_factory=dict)
    runtime_origin_context: dict[str, Any] = field(default_factory=dict)


def collaboration_manager_task_id(
    db: Session, dispatch: LoopItemExecution, activity: ProjectChatMessage
) -> str:
    """Resolve manager identity from recorded rounds, including historical cards."""
    from app.services.loop_item_executions.runtime_identity import (
        execution_conversation_task_id,
    )

    initial = execution_conversation_task_id(dispatch)
    current = initial
    known_ids = {initial}
    dispatch_id = dispatch.runtime_origin_context.get("dispatch_id")
    rounds = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == dispatch.cloud_project_id,
            ProjectChatMessage.task_id == dispatch.loop_item_id,
            ProjectChatMessage.id <= activity.id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .order_by(ProjectChatMessage.id.asc())
        .all()
    )
    seen_rounds: set[str] = set()
    for row in rounds:
        metadata = row.metadata_json or {}
        if metadata.get("dispatch_id") != dispatch_id:
            continue
        if metadata.get("activity_type") != "manager_assignment":
            continue
        round_id = metadata.get("coordination_round_id")
        if not isinstance(round_id, str) or not round_id or round_id in seen_rounds:
            continue
        seen_rounds.add(round_id)
        recorded = metadata.get("manager_runtime_task_id")
        if isinstance(recorded, str) and recorded:
            if recorded not in known_ids:
                raise HTTPException(
                    409, "Collaboration round has an invalid manager session"
                )
            current = recorded
        if row.id == activity.id:
            break
        current = f"{current}-manager-after-{round_id}"
        known_ids.add(current)
    recorded = activity.runtime_task_id or (activity.metadata_json or {}).get(
        "manager_runtime_task_id"
    )
    if recorded:
        if recorded not in known_ids:
            raise HTTPException(
                409, "Collaboration activity has an invalid manager session"
            )
        return str(recorded)
    return current


def collaboration_dispatch_for_activity(
    db: Session,
    request: ProjectChatCommentExecution,
    target: ProjectChatMessage,
    *,
    require_current_assignment: bool = True,
) -> LoopItemExecution:
    """Authorize a group activity against its durable, still-current dispatch."""
    from app.services.collaboration_group_execution import (
        collaboration_group_snapshot_for_dispatch,
    )

    metadata = target.metadata_json or {}
    dispatches = (
        db.query(LoopItemExecution)
        .filter_by(cloud_project_id=request.project_id, loop_item_id=request.task_id)
        .all()
    )
    dispatch = next(
        (
            row
            for row in dispatches
            if row.executor_type == "collaboration_group_dispatch"
            and (
                row.id == metadata.get("execution_id")
                or metadata.get("dispatch_id")
                and row.runtime_origin_context.get("dispatch_id")
                == metadata["dispatch_id"]
            )
        ),
        None,
    )
    if dispatch is None or not dispatch.runtime_device_id:
        raise HTTPException(409, "The collaboration activity has no execution binding")
    item = db.get(LoopItem, request.task_id)
    if item is None:
        raise HTTPException(404, "Issue not found")
    if require_current_assignment:
        collaboration_group_snapshot_for_dispatch(item=item, execution=dispatch)
    return dispatch


def resolve_collaboration_manager_session(
    db: Session,
    request: ProjectChatCommentExecution,
    target: ProjectChatMessage,
) -> BoundCommentSession:
    """Continue the recorded group manager, never create a solo replacement."""
    dispatch = collaboration_dispatch_for_activity(db, request, target)
    task_id = collaboration_manager_task_id(db, dispatch, target)
    agent_id = str(dispatch.runtime_origin_context.get("manager_agent_id") or "")
    if target.agent_id and target.agent_id != agent_id:
        raise HTTPException(409, "The manager session does not match its dispatch")
    return BoundCommentSession(
        executor_owner_user_id=dispatch.executor_owner_user_id,
        runtime_device_id=dispatch.runtime_device_id,
        runtime_task_id=task_id,
        agent_id=agent_id,
        execution_environment=dispatch.execution_environment,
        runtime_selection=dispatch.runtime_selection,
        runtime_origin_context={
            **dispatch.runtime_origin_context,
            "collaboration_dispatch_execution_id": dispatch.id,
        },
    )


def collaboration_member_assignment(
    db: Session,
    request: ProjectChatCommentExecution,
    target: ProjectChatMessage,
    *,
    require_current_assignment: bool = True,
) -> tuple[LoopItemExecution, dict[str, Any]]:
    """Verify the member's recorded assignment, native task, and runner aliases."""
    from app.services.collaboration_member_activity import _manager_assignment
    from app.services.device.identity import resolve_owned_device_alias

    dispatch = collaboration_dispatch_for_activity(
        db, request, target, require_current_assignment=require_current_assignment
    )
    metadata = target.metadata_json or {}
    if (
        any(
            not isinstance(metadata.get(key), str) or not metadata[key]
            for key in ("dispatch_id", "coordination_round_id", "assignment_id")
        )
        or not target.runtime_device_id
        or not target.runtime_task_id
    ):
        raise HTTPException(
            409, "The collaboration member session identity is incomplete"
        )
    values = LoopItemExecutionAssignmentStatus(
        loop_item_id=request.task_id,
        dispatch_id=metadata.get("dispatch_id"),
        round_id=metadata.get("coordination_round_id"),
        assignment_id=metadata.get("assignment_id"),
        runtime_device_id=target.runtime_device_id,
        runtime_task_id=target.runtime_task_id,
        status="completed",
    )
    recorded = _manager_assignment(
        db, project_id=int(request.project_id), values=values
    )
    if recorded is None:
        raise HTTPException(409, "The collaboration member assignment is unavailable")
    assignment = recorded[1]
    expected_task = (
        f"{dispatch.runtime_task_id}-member-{values.round_id}-{values.assignment_id}"
    )
    manager_device = resolve_owned_device_alias(
        db,
        user_id=dispatch.executor_owner_user_id,
        device_id=dispatch.runtime_device_id,
    )
    member_device = resolve_owned_device_alias(
        db, user_id=dispatch.executor_owner_user_id, device_id=target.runtime_device_id
    )
    if (
        target.runtime_task_id != expected_task
        or assignment.get("agent_id") != target.agent_id
        or assignment.get("runtime_task_id") != expected_task
        or manager_device is None
        or member_device is None
        or manager_device.id != member_device.id
    ):
        raise HTTPException(
            409, "The collaboration member session does not match its assignment"
        )
    return dispatch, assignment


def resolve_collaboration_member_session(
    db: Session,
    request: ProjectChatCommentExecution,
    target: ProjectChatMessage,
) -> BoundCommentSession:
    """Authorize the original native member session without replacing its profile."""
    dispatch, assignment = collaboration_member_assignment(db, request, target)
    agent = db.get(ProjectChatAgent, target.agent_id)
    if agent is None or agent.status != "active":
        raise HTTPException(409, "The collaboration member is unavailable")
    binding = bind_collaboration_activity_task(
        db,
        dispatch=dispatch,
        activity=target,
        item=db.get(LoopItem, request.task_id),
        assignment=assignment,
    )
    target.metadata_json = {
        **(target.metadata_json or {}),
        "task_binding_id": str(binding.id),
    }
    return BoundCommentSession(
        executor_owner_user_id=dispatch.executor_owner_user_id,
        runtime_device_id=target.runtime_device_id,
        runtime_task_id=target.runtime_task_id,
        agent_id=agent.id,
        execution_environment=dispatch.execution_environment,
        runtime_selection=dispatch.runtime_selection,
        runtime_origin_context={
            **dispatch.runtime_origin_context,
            "collaboration_dispatch_execution_id": dispatch.id,
            "dispatch_role": "member",
            "workflow_task_title": assignment.get("task_title"),
            "coordination_round_id": target.metadata_json["coordination_round_id"],
            "assignment_id": target.metadata_json["assignment_id"],
        },
    )


def bind_collaboration_manager_activity(
    db: Session,
    *,
    dispatch: LoopItemExecution,
    activity: ProjectChatMessage,
    item: LoopItem,
) -> None:
    """Bind one trusted manager activity to its actual native conversation."""
    task_id = collaboration_manager_task_id(db, dispatch, activity)
    if not dispatch.runtime_device_id:
        raise HTTPException(409, "The collaboration manager environment is unavailable")
    activity.runtime_device_id = dispatch.runtime_device_id
    activity.runtime_task_id = task_id
    bind_collaboration_activity_task(
        db, dispatch=dispatch, activity=activity, item=item
    )


def bind_collaboration_activity_task(
    db: Session,
    *,
    dispatch: LoopItemExecution,
    activity: ProjectChatMessage,
    item: LoopItem,
    assignment: dict[str, Any] | None = None,
) -> LoopItemTaskBinding:
    """Share transcript authorization for manager and member native sessions."""
    from app.schemas.delivery import LoopItemTaskBind
    from app.services.loop_items.service import loop_item_service

    return loop_item_service.bind_execution_task(
        db,
        item_id=item.id,
        values=LoopItemTaskBind(
            deviceId=activity.runtime_device_id,
            taskId=activity.runtime_task_id,
            taskTitle=(assignment or {}).get("task_title") or item.title or "",
            dispatchId=(activity.metadata_json or {}).get("dispatch_id"),
            dispatchRoundId=(activity.metadata_json or {}).get("coordination_round_id"),
            assignmentId=(activity.metadata_json or {}).get("assignment_id"),
        ),
        user_id=dispatch.executor_owner_user_id,
        commit=False,
    )


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
    if binding is None or not binding.task_user_id or not target.agent_id:
        raise HTTPException(409, "The comment has no valid execution binding")
    return BoundCommentSession(
        executor_owner_user_id=binding.task_user_id,
        runtime_device_id=binding.device_id,
        runtime_task_id=binding.task_id,
        agent_id=target.agent_id,
    )
