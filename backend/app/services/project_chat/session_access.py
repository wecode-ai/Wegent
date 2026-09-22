"""Authorize transcript reads using durable project execution identities."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole
from app.schemas.runtime_work import RuntimeTaskAddress, RuntimeTranscriptRequest
from app.services.project_chat.service import project_chat_service


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
        required_role=BaseRole.Reporter,
    )
    executions = (
        db.query(LoopItemExecution)
        .filter_by(
            cloud_project_id=scope.project_id,
            loop_item_id=scope.issue_id,
            runtime_device_id=request.device_id,
            runtime_task_id=request.local_task_id,
        )
        .all()
    )
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
    if not owners or 0 in owners or None in owners:
        raise HTTPException(404, "Project session binding not found")
    if len(owners) != 1:
        raise HTTPException(409, "Project session has conflicting execution owners")
    # Workspace paths and runtime handles are client input, not read authority.
    # The executor resolves its persisted task by the exact bound task ID.
    return owners.pop(), RuntimeTaskAddress(
        deviceId=request.device_id, taskId=request.local_task_id
    )
