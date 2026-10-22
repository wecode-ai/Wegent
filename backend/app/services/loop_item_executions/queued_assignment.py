"""Durable assignment admission and execution preparation by queue consumers."""

from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.services.collaboration_revocation import execution_authorized
from app.services.loop_item_executions.assignment import prepare_assignment
from app.services.loop_item_executions.notification import notify_execution_lifecycle

if TYPE_CHECKING:
    from app.services.loop_item_executions.service import LoopItemExecutionService


def enqueue_assignment(
    service: "LoopItemExecutionService",
    db: Session,
    *,
    loop_item_id: str,
    cloud_project_id: str,
    agent: ProjectChatAgent,
    assigner_user_id: int,
    environment: str,
    execution_device_id: str | None,
    priority: str | None,
    automation_context: dict[str, Any] | None = None,
    continuation: dict[str, Any] | None = None,
) -> LoopItemExecution:
    """Check use authority and persist intent without probing execution readiness."""
    from app.services.project_chat.service import bot_config

    config = bot_config(agent)
    context = {"dispatch_role": "executor", **(automation_context or {})}
    return service._enqueue(
        db,
        loop_item_id=loop_item_id,
        cloud_project_id=cloud_project_id,
        executor_type="project_robot",
        owner_user_id=int(agent.created_by_user_id or assigner_user_id),
        agent_id=agent.id,
        team_id=config.get("wegent_team_id"),
        assigner_user_id=assigner_user_id,
        environment=environment,
        execution_device_id=None,
        priority=priority,
        automation_context=context,
        requires_approval=config.get("execution_mode") == "manual_approval",
        runtime_selection={
            "assignment_request": {
                "environment": environment,
                "execution_device_id": execution_device_id,
                **({"continuation": continuation} if continuation is not None else {}),
            }
        },
    )


def _prepare_one(
    service: "LoopItemExecutionService", db: Session, row: LoopItemExecution
) -> bool:
    request = row.runtime_selection["assignment_request"]
    agent = db.get(ProjectChatAgent, row.agent_id)
    from app.services.project_chat.service import bot_config

    if (
        bot_config(agent).get("execution_mode") == "manual_approval"
        and row.approval_status != "approved"
    ):
        row.status = "pending_approval"
        row.approval_status = "pending"
        notify_execution_lifecycle(db, execution=row, status=row.status)
        _project_preparation(service, db, row)
        return True
    context = row.runtime_origin_context
    continuation = None
    if request.get("continuation") is not None:
        from app.services.loop_item_executions.comment_continuation import (
            prepare_continuation,
        )

        continuation = prepare_continuation(db, row, request["continuation"], context)
        if continuation is None:
            return False
    plan = prepare_assignment(
        service,
        db,
        loop_item_id=row.loop_item_id,
        cloud_project_id=row.cloud_project_id,
        agent=agent,
        assigner_user_id=row.assigner_user_id,
        environment=request["environment"],
        execution_device_id=request.get("execution_device_id"),
        priority=None,
        automation_context=context,
    )
    row.executor_owner_user_id = plan["owner_user_id"]
    row.team_id = plan["team_id"]
    row.execution_environment = plan["environment"]
    row.execution_device_id = plan["execution_device_id"] or ""
    row.execution_payload = service._serialize_execution_intent(
        runtime_selection=plan["runtime_selection"],
        origin_context=plan["automation_context"],
        runtime_request=row.runtime_request or None,
    )
    if continuation is not None:
        from app.services.loop_item_executions.comment_continuation import (
            apply_continuation,
        )

        apply_continuation(service, db, row, continuation)
    if not execution_authorized(db, row):
        raise ValueError("Execution dependencies or resource authority are unavailable")
    if plan["waiting_runtime"]:
        row.status = "waiting_runtime"
        row.execution_note = (
            "Select a model or workspace before this execution can start"
        )
        notify_execution_lifecycle(db, execution=row, status=row.status)
    elif row.execution_device_id and not row.runtime_request:
        service._persist_runtime_request_intent(db, execution=row)
    _project_preparation(service, db, row)
    return True


def _project_preparation(
    service: "LoopItemExecutionService", db: Session, row: LoopItemExecution
) -> None:
    row.version += 1
    activity = service._linked_activity(db, row)
    if activity is not None:
        activity.runtime_device_id = row.runtime_device_id or ""
        activity.runtime_task_id = row.runtime_task_id
        activity.metadata_json = {
            **(activity.metadata_json or {}),
            "run_status": row.status,
        }


def prepare_queued_assignments(
    service: "LoopItemExecutionService", db: Session, *, limit: int = 100
) -> int:
    """Prepare committed requests; failures belong to their execution records."""
    from app.services.loop_item_executions.service import (
        WeworkRuntimeConfigurationError,
    )

    candidates = (
        db.query(LoopItemExecution.id, LoopItemExecution.loop_item_id)
        .filter(
            LoopItemExecution.status == "queued", LoopItemExecution.assignment_pending
        )
        .order_by(LoopItemExecution.id)
        .all()
    )
    prepared = 0
    for execution_id, issue_id in candidates:
        if prepared >= limit:
            break
        # Use the same Issue -> execution lock order as claiming and cancellation.
        issue = (
            db.query(LoopItem)
            .filter_by(id=issue_id)
            .with_for_update(skip_locked=True)
            .populate_existing()
            .first()
        )
        if issue is None:
            db.rollback()
            continue
        row = (
            db.query(LoopItemExecution)
            .filter_by(id=execution_id, status="queued")
            .with_for_update()
            .populate_existing()
            .first()
        )
        if row is None or not row.assignment_pending:
            db.rollback()
            continue
        if not execution_authorized(db, row):
            service.cancel(
                db, execution_id=row.id, note="Execution authorization revoked"
            )
            continue
        try:
            with db.begin_nested():
                ready = _prepare_one(service, db, row)
            if not ready:
                db.rollback()
                continue
            db.commit()
            service._push_activity_after_commit(db, service._linked_activity(db, row))
        except (HTTPException, ValueError, WeworkRuntimeConfigurationError) as error:
            if isinstance(error, HTTPException) and error.status_code >= 500:
                db.rollback()
                raise
            detail = error.detail if isinstance(error, HTTPException) else str(error)
            message = (
                f"{detail.get('error_code', 'EXECUTION_CONFIGURATION')}: "
                f"{detail.get('message', detail)}"
                if isinstance(detail, dict)
                else str(detail)
            )
            service.fail(
                db,
                execution_id=execution_id,
                error=message,
                note="execution_configuration_unavailable",
                expected_status="queued",
                expected_version=row.version,
            )
        prepared += 1
    return prepared
