"""Claim explicit child requests through the existing personal task binding."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from shared.telemetry.decorators import trace_sync

if TYPE_CHECKING:
    from app.schemas.delivery import LoopItemTaskBind


def current_request_attempt(
    db: Session,
    item: LoopItem,
    execution: LoopItemExecution,
    dispatch: dict | None,
    *,
    allow_terminal: bool = False,
) -> bool:
    """A child retains its own identity under the current assignment authority."""
    context = execution.runtime_origin_context
    request_id = context.get("assistant_request_id")
    if (
        not isinstance(request_id, str)
        or execution.execution_scope != f"assistant-request:{request_id}"
        or not isinstance(dispatch, dict)
        or context.get("human_assistant_dispatch") != dispatch.get("dispatchId")
        or context.get("assignment_version") != dispatch.get("assignmentVersion")
        or execution.executor_owner_user_id != item.assignee_user_id
        or execution.status in {"cancelled", "cancel_requested"}
        or (not allow_terminal and execution.status in {"completed", "failed"})
    ):
        return False
    latest = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.cloud_project_id == str(item.cloud_project_id),
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.executor_owner_user_id
            == execution.executor_owner_user_id,
            LoopItemExecution.execution_scope == execution.execution_scope,
        )
        .order_by(LoopItemExecution.id.desc())
        .populate_existing()
        .with_for_update()
        .first()
    )
    return latest is not None and latest.id == execution.id


@trace_sync("assistant_request.claim_binding", tracer_name="backend.loop_items")
def claim_request_for_binding(
    db: Session, item: LoopItem, values: LoopItemTaskBind, user_id: int
) -> str:
    """Validate the frozen request before claiming its existing ledger entry."""
    from app.services.collaboration_human_assignments import direct_human_assignment_id
    from app.services.device.identity import resolve_owned_device_alias
    from app.services.human_assistant_dispatch import (
        _now,
        device_role,
        execution_current,
    )

    request_id = values.assistant_request_id
    execution = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.cloud_project_id == str(item.cloud_project_id),
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.executor_owner_user_id == user_id,
            LoopItemExecution.execution_scope == f"assistant-request:{request_id}",
        )
        .order_by(LoopItemExecution.id.desc())
        .with_for_update()
        .first()
    )
    if execution is None:
        raise HTTPException(404, "Assistant request not found")
    context = execution.runtime_origin_context
    if (
        execution.executor_type != "human_assistant"
        or context.get("assistant_request_id") != request_id
        or context.get("assignment_id") != values.assignment_id
        or context.get("human_assistant_dispatch") != values.human_assistant_dispatch_id
        or values.task_id != f"assistant-request-{request_id}"
        or values.human_assignment_id
        != direct_human_assignment_id(
            issue_id=item.id, assignment_id=values.assignment_id or ""
        )
        or not execution_current(db, execution)
    ):
        raise HTTPException(409, "Assistant request is no longer current")
    device = resolve_owned_device_alias(db, user_id=user_id, device_id=values.device_id)
    selected = resolve_owned_device_alias(
        db, user_id=user_id, device_id=execution.execution_device_id
    )
    if (
        device is None
        or selected is None
        or device.id != selected.id
        or device_role(device, item)[0] is None
    ):
        raise HTTPException(403, "Default assistant is not authorized on this device")
    dependency = execution.execution_intent.get("assistant_request", {}).get(
        "dependencyRequestId"
    )
    if dependency:
        previous = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == item.id,
                LoopItemExecution.executor_owner_user_id == user_id,
                LoopItemExecution.execution_scope == f"assistant-request:{dependency}",
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if previous is None or previous.status not in {
            "completed",
            "failed",
            "cancelled",
        }:
            raise HTTPException(
                409, "Replacement is waiting for the previous request to stop"
            )
    if execution.status != "waiting_runtime":
        if (
            execution.runtime_task_id == values.task_id
            and execution.runtime_device_id == values.device_id
        ):
            return str(execution.id)
        raise HTTPException(409, "Assistant request is already claimed")
    execution.status = "claimed"
    execution.runtime_device_id = values.device_id
    execution.runtime_task_id = values.task_id
    execution.claimed_at = _now()
    execution.start_requested_at = _now()
    execution.lease_expires_at = _now() + timedelta(minutes=5)
    execution.execution_note = ""
    db.flush()
    return str(execution.id)


def terminal_is_current(execution: LoopItemExecution, payload: dict) -> bool:
    """An accepted followup fences an earlier turn, even before delivery ACK."""
    if not execution.runtime_origin_context.get("assistant_request_id"):
        return True
    request = execution.execution_intent.get("assistant_request", {})
    expected = request.get("attemptCommandId") or f"assistant-start:{execution.id}"
    for command in request.get("commands", []):
        if command.get("action") == "followup" and command.get("executionId") == str(
            execution.id
        ):
            expected = command.get("id")
    return payload.get("assistantRequestCommandId") == expected


@trace_sync("assistant_request.revoke_assignment", tracer_name="backend.loop_items")
def cancel_assignment_requests(db: Session, event, reason: str) -> set[int]:
    """Revoking an assignment stops all its child attempts and preserves evidence."""
    from app.services.loop_item_executions.service import loop_item_execution_service

    cancelled = set()
    rows = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == event.loop_item_id,
            LoopItemExecution.executor_owner_user_id == int(event.member_id),
            LoopItemExecution.execution_scope.like("assistant-request:%"),
            LoopItemExecution.status.notin_({"completed", "failed", "cancelled"}),
        )
        .with_for_update()
        .all()
    )
    for row in rows:
        if row.runtime_origin_context.get("assignment_id") != event.id:
            continue
        result = loop_item_execution_service.cancel(
            db, execution_id=row.id, note=reason, commit=False
        )
        if result.status == "cancel_requested":
            cancelled.add(result.id)
    return cancelled
