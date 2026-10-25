"""Authorize transcript reads using durable project execution identities."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import ProjectChatCommentExecution
from app.schemas.runtime_work import RuntimeTaskAddress, RuntimeTranscriptRequest
from app.services.device.identity import owned_device_aliases, same_owned_device
from app.services.loop_item_executions.runtime_identity import (
    execution_conversation_task_id,
)
from app.services.loop_items.task_bindings import active_task_binding_query
from app.services.project_chat.runtime_binding import (
    collaboration_dispatch_for_activity,
    collaboration_member_assignment,
)
from app.services.project_chat.service import project_chat_service


def _session_executions(
    db: Session, request: RuntimeTranscriptRequest
) -> list[LoopItemExecution]:
    scope = request.project_session
    assert scope is not None
    candidate_task_ids = {request.local_task_id}
    manager_suffix = "-manager-initial"
    if request.local_task_id.endswith(manager_suffix):
        candidate_task_ids.add(request.local_task_id.removesuffix(manager_suffix))
    candidates = (
        db.query(LoopItemExecution)
        .filter_by(cloud_project_id=scope.project_id, loop_item_id=scope.issue_id)
        .filter(LoopItemExecution.runtime_task_id.in_(candidate_task_ids))
        .all()
    )
    aliases = {
        owner: owned_device_aliases(db, user_id=owner, device_id=request.device_id)
        for owner in {row.executor_owner_user_id for row in candidates}
    }
    return [
        row
        for row in candidates
        if request.local_task_id
        in {row.runtime_task_id, execution_conversation_task_id(row)}
        and row.runtime_device_id in aliases[row.executor_owner_user_id]
    ]


def _member_session_owners(db: Session, request: RuntimeTranscriptRequest) -> set[int]:
    scope = request.project_session
    assert scope is not None
    activities = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == scope.project_id,
            ProjectChatMessage.task_id == scope.issue_id,
            ProjectChatMessage.runtime_task_id == request.local_task_id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .all()
    )
    owners = set()
    for activity in activities:
        if (activity.metadata_json or {}).get("activity_type") != "member_execution":
            continue
        context = ProjectChatCommentExecution(
            project_id=scope.project_id,
            task_id=scope.issue_id,
            trigger_message_id=activity.message_id,
        )
        dispatch = collaboration_dispatch_for_activity(
            db, context, activity, require_current_assignment=False
        )
        if not same_owned_device(
            db,
            user_id=dispatch.executor_owner_user_id,
            left_device_id=activity.runtime_device_id,
            right_device_id=request.device_id,
        ):
            continue
        collaboration_member_assignment(
            db, context, activity, require_current_assignment=False
        )
        owners.add(dispatch.executor_owner_user_id)
    return owners


def resolve_project_transcript(
    db: Session, user_id: int, request: RuntimeTranscriptRequest
) -> tuple[int, RuntimeTaskAddress]:
    """Grant access to one recorded session, never to the owner's device catalog."""
    scope = request.project_session
    if scope is None:
        raise ValueError("Project session scope is required")
    project_chat_service._require_scope(
        db,
        user_id=user_id,
        project_id=scope.project_id,
        task_id=scope.issue_id,
        required_role=BaseRole.Viewer,
    )
    executions = _session_executions(db, request)
    bindings = active_task_binding_query(
        db,
        project_id=scope.project_id,
        item_id=scope.issue_id,
        device_id=request.device_id,
        task_id=request.local_task_id,
    ).all()
    owners = {row.executor_owner_user_id for row in executions} | {
        row.task_user_id for row in bindings
    }
    if not owners:
        owners = _member_session_owners(db, request)
    if not owners or 0 in owners or None in owners:
        raise HTTPException(404, "Project session binding not found")
    if len(owners) != 1:
        raise HTTPException(409, "Project session has conflicting execution owners")
    task_ids = {execution_conversation_task_id(row) for row in executions}
    if len(task_ids) > 1:
        raise HTTPException(
            409, "Project session has conflicting Runtime task identities"
        )
    # Workspace paths and runtime handles are client input, not read authority.
    # The executor resolves its persisted task by the exact bound task ID.
    return owners.pop(), RuntimeTaskAddress(
        deviceId=request.device_id, taskId=next(iter(task_ids), request.local_task_id)
    )
