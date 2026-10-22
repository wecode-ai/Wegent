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
from app.services.device.identity import same_owned_device
from app.services.loop_items.task_bindings import active_task_binding_query


@dataclass(frozen=True)
class BoundCommentSession:
    executor_owner_user_id: int
    runtime_device_id: str
    runtime_task_id: str
    agent_id: str
    runtime_request: dict[str, Any]
    id: None = None
    team_id: int = 0
    executor_type: str = "project_robot"
    automation_run_id: str = ""
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
    from app.services.loop_item_executions.service import loop_item_execution_service

    dispatch = collaboration_dispatch_for_activity(db, request, target)
    task_id = collaboration_manager_task_id(db, dispatch, target)
    execution_id = (target.metadata_json or {}).get("execution_id")
    source = db.get(LoopItemExecution, execution_id) if execution_id else None
    if source is not None and source.executor_type == "project_robot":
        if (
            source.cloud_project_id != request.project_id
            or source.loop_item_id != request.task_id
            or source.runtime_task_id != task_id
            or not same_owned_device(
                db,
                user_id=source.executor_owner_user_id,
                left_device_id=source.runtime_device_id,
                right_device_id=target.runtime_device_id,
            )
            or source.runtime_origin_context.get("dispatch_id")
            != dispatch.runtime_origin_context.get("dispatch_id")
            or source.agent_id != target.agent_id
            or source.runtime_origin_context.get("dispatch_role") != "manager"
        ):
            raise HTTPException(
                409, "The manager reply no longer matches its execution"
            )
        return BoundCommentSession(
            executor_owner_user_id=source.executor_owner_user_id,
            runtime_device_id=source.runtime_device_id,
            runtime_task_id=task_id,
            agent_id=source.agent_id,
            runtime_request=source.runtime_request,
            runtime_selection=source.runtime_selection,
            runtime_origin_context={
                **source.runtime_origin_context,
                "collaboration_dispatch_execution_id": dispatch.id,
            },
        )
    profile, context = loop_item_execution_service._runtime_profile_and_context(
        db, execution=dispatch
    )
    context = {**context, "collaboration_dispatch_execution_id": dispatch.id}
    task = loop_item_execution_service.resolve_task_context(
        db, execution=dispatch, user_id=dispatch.executor_owner_user_id
    )
    if task is None:
        raise HTTPException(409, "The collaboration Issue is unavailable")
    intent = profile.build_runtime_request(
        db,
        execution_id=dispatch.id,
        runtime_task_id=task_id,
        task=task,
        cloud_project_id=request.project_id,
        origin_context=context,
        execution_device_id=dispatch.runtime_device_id,
    )
    return BoundCommentSession(
        executor_owner_user_id=dispatch.executor_owner_user_id,
        runtime_device_id=dispatch.runtime_device_id,
        runtime_task_id=task_id,
        agent_id=str(context["manager_agent_id"]),
        runtime_request=intent.model_dump(by_alias=True, exclude_none=True),
        runtime_selection=dispatch.runtime_selection,
        runtime_origin_context=context,
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
    """Recompile non-secret member intent from the assigned group profile."""
    from app.services.loop_item_executions.profile import WeworkExecutionProfile
    from app.services.loop_item_executions.service import loop_item_execution_service
    from app.services.runner_routing import profile_for_runner

    dispatch, assignment = collaboration_member_assignment(db, request, target)
    agent = db.get(ProjectChatAgent, target.agent_id)
    if (
        agent is None
        or agent.status != "active"
        or str(agent.cloud_project_id) != request.project_id
    ):
        raise HTTPException(409, "The collaboration member is unavailable")
    profile = WeworkExecutionProfile.for_project_robot(
        agent, db=db, cloud_project_id=request.project_id
    )
    selection = dict(dispatch.runtime_selection)
    if dispatch.uses_runner_routing:
        requirements = selection.get("group_runner_requirements", {}).get(agent.id)
        if requirements is None:
            raise HTTPException(
                409, "The collaboration member model configuration is unavailable"
            )
        profile = profile_for_runner(db, profile, dispatch, requirements)
        selection["runner_routing"] = requirements
    context = {
        **dispatch.runtime_origin_context,
        "collaboration_dispatch_execution_id": dispatch.id,
        "dispatch_role": "member",
        "workflow_task_title": assignment.get("task_title"),
        "execution_prompt": assignment.get("instructions") or "",
        "system_prompt": profile.system_prompt,
        "coordination_round_id": target.metadata_json["coordination_round_id"],
        "assignment_id": target.metadata_json["assignment_id"],
    }
    task = loop_item_execution_service.resolve_task_context(
        db, execution=dispatch, user_id=dispatch.executor_owner_user_id
    )
    if task is None:
        raise HTTPException(409, "The collaboration Issue is unavailable")
    intent = profile.build_runtime_request(
        db,
        execution_id=dispatch.id,
        runtime_task_id=target.runtime_task_id,
        task=task,
        cloud_project_id=request.project_id,
        origin_context=context,
        execution_device_id=target.runtime_device_id,
    )
    intent.origin.update(
        {
            "coordinationRoundId": context["coordination_round_id"],
            "assignmentId": context["assignment_id"],
        }
    )
    return BoundCommentSession(
        executor_owner_user_id=dispatch.executor_owner_user_id,
        runtime_device_id=target.runtime_device_id,
        runtime_task_id=target.runtime_task_id,
        agent_id=agent.id,
        runtime_request=intent.model_dump(by_alias=True, exclude_none=True),
        runtime_selection=selection,
        runtime_origin_context=context,
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
    bindings = active_task_binding_query(
        db,
        project_id=request.project_id,
        item_id=request.task_id,
        device_id=target.runtime_device_id,
        task_id=target.runtime_task_id,
    ).all()
    if len({row.task_user_id for row in bindings}) > 1:
        raise HTTPException(409, "Project session has conflicting execution owners")
    binding = bindings[0] if bindings else None
    if binding is None or not binding.task_user_id or not target.agent_id:
        raise HTTPException(409, "The comment has no valid execution binding")
    selection = binding.model_selection or {}
    team_id = (binding.metadata_json or {}).get("wegent_team_id")
    return BoundCommentSession(
        executor_owner_user_id=binding.task_user_id,
        runtime_device_id=binding.device_id,
        runtime_task_id=binding.task_id,
        agent_id=target.agent_id,
        runtime_request={
            "schemaVersion": 3 if team_id is not None else 2,
            **({"wegentTeamId": team_id} if team_id is not None else {}),
            "runtime": "codex",
            "deviceId": binding.device_id,
            "taskId": binding.task_id,
            "message": "",
            "modelId": selection.get("modelName") or target.metadata_json.get("model"),
            "modelType": selection.get("modelType"),
            "modelOptions": selection.get("options") or {},
            "cloudProjectId": request.project_id,
            "origin": {
                "type": "board_comment",
                "dispatchRole": "executor",
                "cloudProjectId": request.project_id,
                "loopItemId": request.task_id,
            },
            "standaloneChatWorkspace": True,
        },
    )
