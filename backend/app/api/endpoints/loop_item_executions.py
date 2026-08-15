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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.distributed_lock import distributed_lock
from app.core.security import get_current_user
from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import (
    LoopItemExecutionCancel,
    LoopItemExecutionClaim,
    LoopItemExecutionDeviceClaim,
    LoopItemExecutionDispatchFailed,
    LoopItemExecutionDispatchIntent,
    LoopItemExecutionDispatchUnknown,
    LoopItemExecutionHeartbeat,
    LoopItemExecutionListResponse,
    LoopItemExecutionRuntimeStart,
    LoopItemExecutionView,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.device.capacity import get_runtime_capacity_sync
from app.services.loop_item_executions.service import (
    WeworkRuntimeConfigurationError,
    _optional_datetime,
    _optional_text,
    _optional_user_id,
    execution_display_state,
    loop_item_execution_service,
)

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
    if row.executor_owner_user_id != user_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the robot creator can report its runs",
        )
    return row


def _require_project_execution(
    db: Session, *, project_id: int, execution_id: int
) -> LoopItemExecution:
    """Resolve an execution only inside the project named by the route."""

    row = db.get(LoopItemExecution, execution_id)
    if row is None or row.cloud_project_id != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
    return row


def _execution_view(
    db: Session, row: object, *, include_runtime_payload: bool = False
) -> LoopItemExecutionView:
    item = db.get(LoopItem, row.loop_item_id)
    agent = db.get(ProjectChatAgent, row.agent_id) if row.agent_id else None
    if agent is not None:
        from app.services.project_chat.service import bot_max_concurrent_executions

        agent_max_concurrent_executions = bot_max_concurrent_executions(agent)
    else:
        agent_max_concurrent_executions = 1
    return LoopItemExecutionView.model_validate(
        {
            "id": row.id,
            "loop_item_id": row.loop_item_id,
            "cloud_project_id": row.cloud_project_id,
            "task_title": (item.title or item.name or "") if item else "",
            "task_status": item.status if item else None,
            "task_priority": item.priority if item else None,
            "executor_type": row.executor_type,
            "agent_id": _optional_text(row.agent_id),
            "team_id": row.team_id,
            "backend_task_id": row.backend_task_id,
            "automation_run_id": row.automation_run_id,
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
            "runtime_payload": (
                loop_item_execution_service.build_runtime_payload(
                    db,
                    execution=row,
                )
                if include_runtime_payload
                else None
            ),
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
    Runtime heartbeat capacity prevents two transport routes for the same
    installation from over-claiming. Cloud runs are claimed by the Celery
    worker directly, never through this endpoint.
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
    capacity = get_runtime_capacity_sync(
        db,
        owner_user_id=current_user.id,
        device_id=values.execution_device_id,
    )
    if capacity is None:
        return None
    lock_key = f"robot_exec:{current_user.id}:runtime:{capacity.runtime_instance_id}"
    with distributed_lock.acquire_context(
        f"robot_exec_owner:{current_user.id}", expire_seconds=30
    ) as owner_acquired:
        if not owner_acquired:
            return None
        with distributed_lock.acquire_context(
            lock_key, expire_seconds=30
        ) as device_acquired:
            if not device_acquired:
                return None
            row = loop_item_execution_service.claim(
                db,
                agent_id=values.agent_id,
                execution_device_id=values.execution_device_id,
                environment=values.execution_environment,
                owner_user_id=current_user.id,
                runtime_instance_id=capacity.runtime_instance_id,
                device_capacity=capacity.limit,
                runtime_active=capacity.active,
                runtime_active_task_ids=capacity.active_task_ids,
                lease_seconds=values.lease_seconds,
                assigner_filter=values.assigner_user_id,
            )
    return _claimed_execution_view(db, row) if row else None


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
    and returns it with a just-in-time runtime request. Runtime heartbeat
    capacity and the atomic CAS keep multiple routes from over-claiming.
    """

    capacity = get_runtime_capacity_sync(
        db,
        owner_user_id=current_user.id,
        device_id=values.execution_device_id,
    )
    if capacity is None:
        return None
    lock_key = f"robot_exec:{current_user.id}:runtime:{capacity.runtime_instance_id}"
    with distributed_lock.acquire_context(
        f"robot_exec_owner:{current_user.id}", expire_seconds=30
    ) as owner_acquired:
        if not owner_acquired:
            return None
        with distributed_lock.acquire_context(
            lock_key, expire_seconds=30
        ) as device_acquired:
            if not device_acquired:
                return None
            row = loop_item_execution_service.claim_next_for_device(
                db,
                execution_device_id=values.execution_device_id,
                environment="local",
                runtime_instance_id=capacity.runtime_instance_id,
                device_capacity=capacity.limit,
                runtime_active=capacity.active,
                runtime_active_task_ids=capacity.active_task_ids,
                lease_seconds=values.lease_seconds,
                owner_user_id=current_user.id,
            )
            if row is None:
                row = loop_item_execution_service.claim_next_unbound_local(
                    db,
                    owner_user_id=current_user.id,
                    execution_device_id=values.execution_device_id,
                    runtime_instance_id=capacity.runtime_instance_id,
                    device_capacity=capacity.limit,
                    runtime_active=capacity.active,
                    runtime_active_task_ids=capacity.active_task_ids,
                    lease_seconds=values.lease_seconds,
                )
    if row is None:
        return None
    if row.executor_owner_user_id != current_user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Claimed Wework execution belongs to another user",
        )
    return _claimed_execution_view(db, row)


def _claimed_execution_view(
    db: Session,
    row: LoopItemExecution,
) -> LoopItemExecutionView:
    """Materialize a claimed run or durably fail an unavailable model."""

    try:
        return _execution_view(db, row, include_runtime_payload=True)
    except WeworkRuntimeConfigurationError as exc:
        logger.warning(
            "[LoopItemExecution] Runtime configuration unavailable "
            "execution=%s model_error=%s",
            row.id,
            str(exc),
        )
        loop_item_execution_service.fail_runtime_preflight(
            db,
            execution_id=row.id,
            error=str(exc),
            note="runtime_configuration_unavailable",
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


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
    "/{project_id}/executions/{execution_id}/start-requested",
    response_model=Optional[LoopItemExecutionView],
)
def request_runtime_start(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionDispatchIntent,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Persist delivery intent before the App sends Runtime create."""

    _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.request_runtime_start(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
    )
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/dispatch-unknown",
    response_model=Optional[LoopItemExecutionView],
)
def report_runtime_dispatch_unknown(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionDispatchUnknown,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Record an ambiguous App-to-Runtime create outcome for reconciliation."""

    _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.report_runtime_dispatch_unknown(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
        error=values.error,
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
    """Record Runtime acceptance without claiming that execution has started."""

    _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    accepted = loop_item_execution_service.accept_runtime_and_open_activity(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
        prompt=values.prompt,
    )
    return _execution_view(db, accepted) if accepted is not None else None


@router.post(
    "/{project_id}/executions/{execution_id}/dispatch-failed",
    response_model=Optional[LoopItemExecutionView],
)
def fail_runtime_preflight(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionDispatchFailed,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    _require_run_creator(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.fail_runtime_preflight(
        db,
        execution_id=execution_id,
        error=values.error,
        note=values.note,
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
    if row.team_id is not None and row.backend_task_id:
        from app.services.project_automation_managed_execution import (
            project_automation_managed_execution_service,
        )

        background_tasks.add_task(
            project_automation_managed_execution_service.cancel,
            task_id=row.backend_task_id,
            user_id=row.executor_owner_user_id,
            source="board_team_assignment",
        )
    if (
        row is not None
        and row.status == "cancel_requested"
        and row.runtime_device_id
        and row.runtime_task_id
    ):
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
    """Stop a run from the automation page (project member action)."""

    require_cloud_project_role(db, project_id, current_user.id, BaseRole.Developer)
    _require_project_execution(
        db,
        project_id=project_id,
        execution_id=execution_id,
    )
    row = loop_item_execution_service.cancel(
        db,
        execution_id=execution_id,
        note="Stopped from the automation queue",
    )
    if row.team_id is not None and row.backend_task_id:
        from app.services.project_automation_managed_execution import (
            project_automation_managed_execution_service,
        )

        background_tasks.add_task(
            project_automation_managed_execution_service.cancel,
            task_id=row.backend_task_id,
            user_id=row.executor_owner_user_id,
            source="board_team_assignment",
        )
    if (
        row is not None
        and row.status == "cancel_requested"
        and row.runtime_device_id
        and row.runtime_task_id
    ):
        from app.tasks.robot_queue_tasks import emit_runtime_cancels

        background_tasks.add_task(emit_runtime_cancels, [row])
    return _execution_view(db, row) if row else None
