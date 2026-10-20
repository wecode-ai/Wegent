"""Authorize transcript reads using durable project execution identities."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import ProjectChatCommentExecution
from app.schemas.runtime_work import RuntimeSessionReadRequest, RuntimeTaskAddress
from app.services.loop_item_executions.runtime_identity import (
    execution_conversation_task_id,
)
from app.services.project_chat.runtime_binding import collaboration_member_assignment
from app.services.project_chat.service import project_chat_service


def resolve_project_transcript(
    db: Session, user_id: int, request: RuntimeSessionReadRequest
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
    candidate_task_ids = {request.local_task_id}
    manager_suffix = "-manager-initial"
    if request.local_task_id.endswith(manager_suffix):
        candidate_task_ids.add(request.local_task_id.removesuffix(manager_suffix))
    candidates = (
        db.query(LoopItemExecution)
        .filter_by(
            cloud_project_id=scope.project_id,
            loop_item_id=scope.issue_id,
            runtime_device_id=request.device_id,
        )
        .filter(LoopItemExecution.runtime_task_id.in_(candidate_task_ids))
        .all()
    )
    executions = [
        row
        for row in candidates
        if request.local_task_id
        in {row.runtime_task_id, execution_conversation_task_id(row)}
    ]
    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.cloud_project_id == scope.project_id,
            LoopItemTaskBinding.loop_item_id == scope.issue_id,
            LoopItemTaskBinding.device_id == request.device_id,
            LoopItemTaskBinding.task_id == request.local_task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
        )
        .all()
    )
    owners = {row.executor_owner_user_id for row in executions} | {
        row.task_user_id for row in bindings
    }
    if not owners:
        activities = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.project_id == scope.project_id,
                ProjectChatMessage.task_id == scope.issue_id,
                ProjectChatMessage.runtime_device_id == request.device_id,
                ProjectChatMessage.runtime_task_id == request.local_task_id,
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .all()
        )
        for activity in activities:
            if (activity.metadata_json or {}).get(
                "activity_type"
            ) != "member_execution":
                continue
            dispatch, _ = collaboration_member_assignment(
                db,
                ProjectChatCommentExecution(
                    project_id=scope.project_id,
                    task_id=scope.issue_id,
                    trigger_message_id=activity.message_id,
                ),
                activity,
                require_current_assignment=False,
            )
            owners.add(dispatch.executor_owner_user_id)
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
