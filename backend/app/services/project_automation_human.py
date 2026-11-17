"""Project personal assistant facts onto their originating automation run."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    Delivery,
    LoopItemTaskBinding,
    ProjectAutomationRun,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.services.project_automation_domain import TERMINAL_RUN_STATUSES, utcnow

CONTEXT_KEY = "human_automation"


def visible_context(context: Any, viewer_user_id: int | None = None) -> dict | None:
    """Only the recipient may see their personal Runtime address."""
    if not isinstance(context, dict):
        return None
    result = deepcopy(context)
    if viewer_user_id is None or context.get("owner_user_id") != viewer_user_id:
        for key in ("runtime_device_id", "runtime_task_id", "endpoint_ref"):
            result.pop(key, None)
    return result


def _metadata(row: Any) -> dict:
    value = row.metadata_json
    return value if isinstance(value, dict) else {}


def _active_assignment(db: Session, run: Any, context: dict) -> Any:
    from app.services.issue_assignments import issue_assignment_service

    event = issue_assignment_service.active(
        db,
        issue_id=run.task_id,
        member_type="human",
        member_id=str(context["owner_user_id"]),
        workflow_step=context.get("workflow_stage_id"),
    )
    if event is None or event.id != context.get("assignment_id"):
        raise HTTPException(409, "Automation assignment is no longer current")
    automation = event.metadata.get("automation") or {}
    if str(automation.get("run_id") or "") != str(run.id):
        raise HTTPException(409, "Automation assignment identity does not match")
    return event


def _project_run(
    db: Session, run: Any, context: dict, state: str, reason: str | None = None
) -> None:
    if run.status in TERMINAL_RUN_STATUSES:
        return
    context = {**context, "state": state, "reason_code": reason}
    if run.status == state and _metadata(run).get(CONTEXT_KEY) == context:
        return
    run.metadata_json = {**_metadata(run), CONTEXT_KEY: context}
    run.status = state
    run.description = reason or ""
    if state in TERMINAL_RUN_STATUSES:
        run.completed_at = utcnow()
    run.version += 1
    message_id = _metadata(run).get("activity_message_id")
    if not message_id:
        return
    message = db.query(ProjectChatMessage).filter_by(message_id=message_id).first()
    if message is None:
        return
    message.status = "completed" if state == "succeeded" else state
    message.metadata_json = {
        **_metadata(message),
        "run_status": state,
        CONTEXT_KEY: visible_context(context),
    }


def initialize_human_automation(
    db: Session, *, run: Any, context: dict, target_user_id: int
) -> None:
    from app.services.issue_assignments import issue_assignment_service

    stage = (context.get("workflow_stage_input") or {}).get("target_stage") or {}
    event = issue_assignment_service.active(
        db,
        issue_id=run.task_id,
        member_type="human",
        member_id=str(target_user_id),
        workflow_step=stage.get("id"),
    )
    contract = event.metadata.get(CONTEXT_KEY) if event else None
    if not isinstance(contract, dict) or contract.get("automation_run_id") != str(
        run.id
    ):
        raise RuntimeError("Human automation assignment has no trusted run context")
    contract = {**deepcopy(contract), "owner_user_id": target_user_id}
    dispatch = event.metadata.get("human_assistant_dispatch") or {}
    contract["endpoint_ref"] = dispatch.get("endpointRef")
    contract["execution_id"] = dispatch.get("executionId")
    run.metadata_json = {**_metadata(run), CONTEXT_KEY: contract}
    if dispatch.get("executionId"):
        execution = db.get(LoopItemExecution, dispatch["executionId"])
        if execution is not None:
            execution.automation_run_id = str(run.id)
            project_human_execution(db, execution=execution)
            return
    reason = dispatch.get("reasonCode") or "assistant_receipts_unavailable"
    state = (
        "blocked"
        if dispatch.get("dispatchState") == "no_authorized_assistant"
        else "waiting"
    )
    _project_run(db, run, contract, state, reason)


def human_binding_metadata(db: Session, execution_id: str | None) -> dict:
    if not execution_id:
        return {}
    execution = db.get(LoopItemExecution, execution_id)
    if execution is None:
        return {}
    contract = execution.runtime_origin_context.get(CONTEXT_KEY)
    if not isinstance(contract, dict):
        return {}
    return {CONTEXT_KEY: deepcopy(contract)}


def project_human_execution(db: Session, *, execution: LoopItemExecution) -> bool:
    contract = execution.runtime_origin_context.get(CONTEXT_KEY)
    if not isinstance(contract, dict) or execution.executor_type != "human_assistant":
        return False
    run = (
        db.query(ProjectAutomationRun)
        .filter_by(
            id=contract.get("automation_run_id"),
            cloud_project_id=execution.cloud_project_id,
            task_id=execution.loop_item_id,
        )
        .with_for_update()
        .first()
    )
    if run is None:
        return True
    saved = _metadata(run).get(CONTEXT_KEY)
    if not isinstance(saved, dict) or saved.get("idempotency_key") != contract.get(
        "idempotency_key"
    ):
        return True
    try:
        event = _active_assignment(db, run, saved)
    except HTTPException:
        state = "cancelled" if execution.status == "cancelled" else "waiting"
        _project_run(db, run, saved, state, "assignment_superseded")
        return True
    dispatch = event.metadata.get("human_assistant_dispatch") or {}
    state = execution.status
    reason = execution.termination_reason or None
    if state == "waiting_runtime":
        state = (
            "waiting_device"
            if dispatch.get("dispatchState") == "waiting_device"
            else "queued"
        )
        reason = dispatch.get("reasonCode")
    elif state in {"claimed", "queued"}:
        state, reason = "queued", "awaiting_runtime"
    elif state == "completed":
        state, reason = "blocked", "required_delivery_pending"
    elif state == "cancel_requested":
        state, reason = "waiting", "cancel_requested"
    elif state == "running" and execution.observed_state in {
        "waiting_user",
        "requires_action",
    }:
        state, reason = "waiting_user", "waiting_user"
    contract = {
        **saved,
        "execution_id": str(execution.id),
        "endpoint_ref": dispatch.get("endpointRef"),
        "runtime_device_id": execution.runtime_device_id or None,
        "runtime_task_id": execution.runtime_task_id or None,
    }
    _project_run(db, run, contract, state, reason)
    return True


def delivery_context(
    db: Session, binding: LoopItemTaskBinding | None, snapshot: dict | None = None
) -> tuple[Any | None, dict | None]:
    contract = _metadata(binding).get(CONTEXT_KEY) if binding is not None else None
    previous = (snapshot or {}).get("humanAutomation")
    if snapshot is not None and previous != contract:
        raise HTTPException(409, "Delivery belongs to an earlier automation assignment")
    if not isinstance(contract, dict):
        return None, None
    run = (
        db.query(ProjectAutomationRun)
        .filter_by(
            id=contract.get("automation_run_id"),
            cloud_project_id=binding.cloud_project_id,
            task_id=binding.loop_item_id,
        )
        .with_for_update()
        .first()
    )
    saved = _metadata(run).get(CONTEXT_KEY) if run is not None else None
    if (
        not isinstance(saved, dict)
        or saved.get("idempotency_key") != contract.get("idempotency_key")
        or saved.get("owner_user_id") != binding.task_user_id
        or run.status in {"failed", "cancelled", "skipped"}
    ):
        raise HTTPException(409, "Automation Delivery source is no longer active")
    _active_assignment(db, run, saved)
    return run, deepcopy(contract)


def complete_human_delivery(
    db: Session, *, run: Any, contract: dict, delivery: Delivery
) -> None:
    context = _metadata(run)[CONTEXT_KEY]
    if context.get("idempotency_key") != contract.get("idempotency_key"):
        raise HTTPException(409, "Automation Delivery identity does not match")
    _project_run(db, run, {**context, "delivery_id": str(delivery.id)}, "succeeded")
