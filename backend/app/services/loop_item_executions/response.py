"""Shared execution response projection for work-container HTTP handlers."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent
from app.schemas.project_chat import LoopItemExecutionView
from app.services.loop_item_executions.service import (
    _optional_datetime,
    _optional_text,
    _optional_user_id,
    execution_display_state,
    loop_item_execution_service,
)
from app.services.workspaces.storage import workspace_id_for_project


def execution_view(
    db: Session,
    row: object,
    *,
    viewer_user_id: int | None = None,
    include_runtime_payload: bool = False,
) -> LoopItemExecutionView:
    item = db.get(LoopItem, row.loop_item_id)
    origin_context = row.runtime_origin_context
    workflow_task_title = str(origin_context.get("workflow_task_title") or "").strip()
    agent = db.get(ProjectChatAgent, row.agent_id) if row.agent_id else None
    if agent is not None:
        from app.services.project_chat.service import bot_max_concurrent_executions

        agent_max_concurrent_executions = bot_max_concurrent_executions(agent)
    else:
        agent_max_concurrent_executions = 1
    runtime_payload = (
        loop_item_execution_service.build_runtime_payload(
            db,
            execution=row,
        )
        if include_runtime_payload
        else None
    )
    return LoopItemExecutionView.model_validate(
        {
            "id": row.id,
            "loop_item_id": row.loop_item_id,
            "cloud_project_id": row.cloud_project_id,
            "workspace_id": workspace_id_for_project(db, row.cloud_project_id),
            "task_title": workflow_task_title
            or ((item.title or item.name or "") if item else ""),
            "task_status": item.status if item else None,
            "task_priority": item.priority if item else None,
            "executor_type": row.executor_type,
            "agent_id": _optional_text(row.agent_id),
            "team_id": row.optional_team_id,
            "backend_task_id": row.optional_backend_task_id,
            "automation_run_id": row.automation_run_id,
            "executor_owner_user_id": _optional_user_id(row.executor_owner_user_id),
            "assigner_user_id": row.assigner_user_id,
            "execution_environment": row.execution_environment,
            "execution_device_id": _optional_text(row.execution_device_id),
            "runtime_instance_id": _optional_text(row.runtime_instance_id),
            "status": row.status,
            "display_state": execution_display_state(row),
            "observed_state": row.observed_state,
            "sync_state": row.sync_state,
            "priority_weight": row.priority_weight,
            "queued_at": _optional_datetime(row.queued_at),
            "started_at": _optional_datetime(row.started_at),
            "completed_at": _optional_datetime(row.completed_at),
            "lease_expires_at": _optional_datetime(row.lease_expires_at),
            "heartbeat_at": _optional_datetime(row.heartbeat_at),
            "claimed_at": _optional_datetime(row.claimed_at),
            "start_requested_at": _optional_datetime(row.start_requested_at),
            "observed_at": _optional_datetime(row.observed_at),
            "cancel_requested_at": _optional_datetime(row.cancel_requested_at),
            "attempt_no": row.attempt_no,
            "previous_execution_id": row.previous_execution_id or None,
            "execution_scope": row.execution_scope,
            "last_event_seq": row.last_event_seq,
            "termination_reason": row.termination_reason,
            "retry_attempt": row.retry_attempt,
            "error_message": row.error_message,
            "execution_note": row.execution_note,
            "approval_status": _optional_text(row.approval_status),
            "approved_by_user_id": _optional_user_id(row.approved_by_user_id),
            "rejected_reason": _optional_text(row.rejected_reason),
            "runtime_device_id": _optional_text(row.runtime_device_id),
            "runtime_task_id": _optional_text(row.runtime_task_id),
            "agent_max_concurrent_executions": agent_max_concurrent_executions,
            "runtime_profile_id": row.runtime_selection.get("runtime_profile_id"),
            "runtime_source": row.runtime_selection.get("runtime_source"),
            "can_select_runtime": (
                viewer_user_id is not None
                and row.executor_owner_user_id == viewer_user_id
                and not row.uses_runner_routing
                and row.status in {"waiting_runtime", "queued"}
            ),
            "waiting_runtime_reason": (
                row.execution_note if row.status == "waiting_runtime" else None
            ),
            "runtime_payload": runtime_payload,
            "version": row.version,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    )
