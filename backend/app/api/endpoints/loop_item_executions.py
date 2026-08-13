# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project robot queue execution endpoints.

The queue is a derived view over `loop_item_executions`; these endpoints power
the queue page, the local App puller (claim/heartbeat/write-back), and the
cloud Celery dispatcher (which also calls the service directly).
"""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import (
    LoopItemExecutionCancel,
    LoopItemExecutionClaim,
    LoopItemExecutionComplete,
    LoopItemExecutionDeviceClaim,
    LoopItemExecutionFail,
    LoopItemExecutionHeartbeat,
    LoopItemExecutionListResponse,
    LoopItemExecutionRuntimeStart,
    LoopItemExecutionView,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_item_executions.service import (
    _optional_datetime,
    _optional_text,
    _optional_user_id,
    loop_item_execution_service,
)
from app.services.project_automations import project_automation_service

logger = logging.getLogger(__name__)

router = APIRouter()
claim_router = APIRouter()


def _require_robot_creator(
    db: Session, *, project_id: int, agent_id: str, user_id: int
) -> ProjectChatAgent:
    """The creator's App/device is the only API caller for a robot's runs."""

    agent = db.get(ProjectChatAgent, agent_id)
    if (
        agent is None
        or agent.cloud_project_id != str(project_id)
        or agent.status != "active"
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Robot not found")
    if agent.created_by_user_id != user_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the robot creator can claim or report its runs",
        )
    return agent


def _require_run_creator(
    db: Session, *, project_id: int, execution_id: int, user_id: int
) -> LoopItemExecution:
    """The robot creator's App/worker is the only runtime write-back caller."""

    row = db.get(LoopItemExecution, execution_id)
    if row is None or row.cloud_project_id != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
    agent = db.get(ProjectChatAgent, row.agent_id)
    if agent is None or agent.created_by_user_id != user_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the robot creator can report its runs",
        )
    return row


def _execution_view(
    db: Session, row: object, *, include_payload: bool = False
) -> LoopItemExecutionView:
    item = db.get(LoopItem, row.loop_item_id)
    return LoopItemExecutionView.model_validate(
        {
            "id": row.id,
            "loop_item_id": row.loop_item_id,
            "cloud_project_id": row.cloud_project_id,
            "task_title": (item.title or item.name or "") if item else "",
            "task_status": item.status if item else None,
            "task_priority": item.priority if item else None,
            "agent_id": row.agent_id,
            "assigner_user_id": row.assigner_user_id,
            "execution_environment": row.execution_environment,
            "execution_device_id": _optional_text(row.execution_device_id),
            "status": row.status,
            "priority_weight": row.priority_weight,
            "queued_at": _optional_datetime(row.queued_at),
            "started_at": _optional_datetime(row.started_at),
            "completed_at": _optional_datetime(row.completed_at),
            "lease_expires_at": _optional_datetime(row.lease_expires_at),
            "heartbeat_at": _optional_datetime(row.heartbeat_at),
            "retry_attempt": row.retry_attempt,
            "error_message": row.error_message,
            "execution_note": row.execution_note,
            "approval_status": _optional_text(row.approval_status),
            "approved_by_user_id": _optional_user_id(row.approved_by_user_id),
            "rejected_reason": _optional_text(row.rejected_reason),
            "runtime_device_id": _optional_text(row.runtime_device_id),
            "runtime_task_id": _optional_text(row.runtime_task_id),
            "execution_payload": (row.execution_payload if include_payload else None),
            "version": row.version,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    )


@router.get(
    "/{project_id}/executions",
    response_model=LoopItemExecutionListResponse,
)
def list_executions(
    project_id: int,
    agent_id: Optional[str] = Query(default=None),
    assigner_user_id: Optional[int] = Query(default=None),
    status: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemExecutionListResponse:
    project = require_cloud_project_role(
        db, project_id, current_user.id, BaseRole.Reporter
    ).project
    rows = loop_item_execution_service.list_queue(
        db,
        project_id=str(project_id),
        agent_id=agent_id,
        assigner_user_id=assigner_user_id,
        status_filter=status,
    )
    if project.task_provider in {"github", "gitlab"}:
        from app.services.loop_items.external_provider import (
            external_loop_item_provider,
        )

        issues = external_loop_item_provider.list(db, project_id, current_user.id)
        by_id = {str(issue["id"]): issue for issue in issues}
        for row in rows:
            issue = by_id.get(str(row["loop_item_id"]))
            row["task_title"] = str(issue.get("title") or "") if issue else ""
            row["task_status"] = issue.get("status") if issue else None
            row["task_priority"] = issue.get("priority") if issue else None
    else:
        item_ids = [row["loop_item_id"] for row in rows]
        items = (
            db.query(LoopItem).filter(LoopItem.id.in_(item_ids)).all()
            if item_ids
            else []
        )
        by_id = {item.id: item for item in items}
        for row in rows:
            item = by_id.get(str(row["loop_item_id"]))
            row["task_title"] = (item.title or item.name or "") if item else ""
            row["task_status"] = item.status if item else None
            row["task_priority"] = item.priority if item else None
    return LoopItemExecutionListResponse(
        items=[LoopItemExecutionView.model_validate(row) for row in rows],
        total=len(rows),
    )


@router.post(
    "/{project_id}/executions/claim",
    response_model=Optional[LoopItemExecutionView],
)
def claim_execution(
    project_id: int,
    values: LoopItemExecutionClaim,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Claim the next queued run for a robot on the caller's device.

    Local App pullers are the only API callers; the atomic CAS plus the
    caller-supplied device capacity prevents two of the creator's computers
    from claiming the same run. Cloud runs are claimed by the Celery worker
    directly, never through this endpoint.
    """

    if values.execution_environment != "local":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Only local runs can be claimed through this endpoint",
        )
    _require_robot_creator(
        db,
        project_id=project_id,
        agent_id=values.agent_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.claim(
        db,
        agent_id=values.agent_id,
        execution_device_id=values.execution_device_id,
        environment=values.execution_environment,
        lease_seconds=values.lease_seconds,
        device_capacity=values.device_capacity,
        assigner_filter=values.assigner_user_id,
    )
    view = _execution_view(db, row, include_payload=True) if row else None
    if view is not None:
        task = loop_item_execution_service.resolve_task_context(
            db, execution=row, user_id=current_user.id
        )
        payload = (
            loop_item_execution_service.build_runtime_payload(
                db, execution=row, task=task
            )
            if task is not None
            else None
        )
        view.execution_payload = payload
    return view


@claim_router.post(
    "/loop-item-executions/claim-my-next",
    response_model=Optional[LoopItemExecutionView],
)
def claim_my_next_execution(
    values: LoopItemExecutionDeviceClaim,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Device-scoped claim used by the creator's local App puller.

    Finds the next queued local run for any robot bound to the caller's device
    and returns it with the prebuilt runtime payload. The atomic CAS plus the
    caller-supplied device capacity keeps multiple computers from double-
    claiming the same run.
    """

    project_automation_service.activate_waiting_for_device(
        db,
        user_id=current_user.id,
        device_id=values.execution_device_id,
    )
    while True:
        row = loop_item_execution_service.claim_next_for_device(
            db,
            execution_device_id=values.execution_device_id,
            environment="local",
            lease_seconds=values.lease_seconds,
            device_capacity=values.device_capacity,
        )
        if row is None:
            row = loop_item_execution_service.claim_next_unbound_local(
                db,
                creator_user_id=current_user.id,
                execution_device_id=values.execution_device_id,
                lease_seconds=values.lease_seconds,
            )
        if row is None:
            return None
        agent = db.get(ProjectChatAgent, row.agent_id)
        if (
            agent is not None
            and agent.created_by_user_id == current_user.id
            and (
                agent.device_id == values.execution_device_id
                or row.execution_device_id == values.execution_device_id
            )
        ):
            view = _execution_view(db, row, include_payload=True)
            task = loop_item_execution_service.resolve_task_context(
                db, execution=row, user_id=current_user.id
            )
            payload = (
                loop_item_execution_service.build_runtime_payload(
                    db, execution=row, task=task
                )
                if task is not None
                else None
            )
            view.execution_payload = payload
            return view
        # Not this user's robot (should not happen for bound devices), skip it.
        loop_item_execution_service.cancel(
            db,
            execution_id=row.id,
            note="Claimed by a device that does not own the robot",
        )


@router.post(
    "/{project_id}/executions/{execution_id}/heartbeat",
    response_model=Optional[LoopItemExecutionView],
)
def heartbeat_execution(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionHeartbeat,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.heartbeat(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
        lease_seconds=values.lease_seconds,
    )
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/runtime-start",
    response_model=Optional[LoopItemExecutionView],
)
def runtime_start_execution(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionRuntimeStart,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Record the created runtime task and open the task-detail AI message."""

    row = _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    heartbeat_view = loop_item_execution_service.heartbeat(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
    )
    if heartbeat_view is not None:
        try:
            loop_item_execution_service.open_execution_activity(
                db,
                execution=row,
                prompt=values.prompt,
            )
        except Exception:
            # The run itself is healthy; the activity message is best-effort.
            logger.exception(
                "[LoopItemExecution] Runtime start activity open failed execution=%s",
                execution_id,
            )
    return _execution_view(db, row) if heartbeat_view is not None else None


@router.post(
    "/{project_id}/executions/{execution_id}/complete",
    response_model=Optional[LoopItemExecutionView],
)
def complete_execution(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionComplete,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.complete(
        db, execution_id=execution_id, note=values.note
    )
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/fail",
    response_model=Optional[LoopItemExecutionView],
)
def fail_execution(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionFail,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.fail(
        db,
        execution_id=execution_id,
        error=values.error,
        note=values.note,
        requeue=values.requeue,
    )
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/cancel",
    response_model=Optional[LoopItemExecutionView],
)
def cancel_execution(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionCancel,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.cancel(
        db, execution_id=execution_id, note=values.note
    )
    if row is not None and row.runtime_device_id and row.runtime_task_id:
        from app.tasks.robot_queue_tasks import emit_runtime_cancels

        background_tasks.add_task(emit_runtime_cancels, [row])
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/stop",
    response_model=Optional[LoopItemExecutionView],
)
def stop_execution(
    project_id: int,
    execution_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Stop a run from the automation page (project member action).

    Cancels the queued/claimed/running execution and best-effort asks the
    executor to terminate its codex session, so the task unlocks and the
    device slot frees without hunting for the per-message stop button.
    """

    require_cloud_project_role(db, project_id, current_user.id, BaseRole.Developer)
    row = loop_item_execution_service.cancel(
        db,
        execution_id=execution_id,
        note="Stopped from the automation queue",
    )
    if row is not None and row.runtime_device_id and row.runtime_task_id:
        from app.tasks.robot_queue_tasks import emit_runtime_cancels

        background_tasks.add_task(emit_runtime_cancels, [row])
    return _execution_view(db, row) if row else None
