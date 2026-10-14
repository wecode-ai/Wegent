# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executor-initiated execution delivery.

The connected Executor owns the transport, so it pulls work through its current
Socket.IO connection. MySQL remains the durable queue and the existing
LoopItemExecution service owns claiming, leases, and runtime state.
"""

import logging
from typing import Any

from app.core.distributed_lock import distributed_lock
from app.db.session import get_db_session
from app.models.delivery import loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.services.loop_item_executions.profile import WeworkExecutionProfileError
from app.services.loop_item_executions.service import (
    WeworkRuntimeConfigurationError,
    loop_item_execution_service,
)
from app.services.workspace_cleanup_intents import pull_due

logger = logging.getLogger(__name__)

DEVICE_PULL_LOCK_SECONDS = 30


def _unconfirmed_claim(
    db,
    *,
    owner_user_id: int,
    runtime_device_id: str,
    runtime_instance_id: str,
    environment: str,
) -> LoopItemExecution | None:
    """Return work reserved by this Runtime but not yet acknowledged.

    Probe without locks before locking an existing claim by its primary key.
    A locking range read can lock queued rows when no claim exists, reversing
    the Issue-first lock order used by claim_routing for competing runners.
    """

    filters = (
        LoopItemExecution.executor_owner_user_id == owner_user_id,
        LoopItemExecution.runtime_device_id == runtime_device_id,
        LoopItemExecution.runtime_instance_id == runtime_instance_id,
        LoopItemExecution.execution_environment == environment,
        LoopItemExecution.status == "claimed",
        loop_datetime_is_unset(LoopItemExecution.start_requested_at),
    )
    candidate = (
        db.query(LoopItemExecution.id)
        .filter(*filters)
        .order_by(LoopItemExecution.claimed_at.asc(), LoopItemExecution.id.asc())
        .first()
    )
    if candidate is None:
        return None
    return (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.id == candidate.id, *filters)
        .with_for_update()
        .populate_existing()
        .first()
    )


def _runtime_prompt(payload: dict[str, Any]) -> str | None:
    request = payload.get("executionRequest")
    if not isinstance(request, dict):
        return None
    prompt = request.get("prompt")
    return prompt if isinstance(prompt, str) else None


def _claim_execution(
    *,
    owner_user_id: int,
    execution_target_id: str,
    runtime_device_id: str,
    runtime_instance_id: str,
    environment: str,
) -> dict[str, Any]:
    with get_db_session() as db:
        row = _unconfirmed_claim(
            db,
            owner_user_id=owner_user_id,
            runtime_device_id=runtime_device_id,
            runtime_instance_id=runtime_instance_id,
            environment=environment,
        )
        if row is not None:
            row = loop_item_execution_service.heartbeat(
                db,
                execution_id=row.id,
                runtime_device_id=runtime_device_id,
                runtime_task_id=row.runtime_task_id,
            )
            logger.warning(
                "[RobotQueue] Redelivering unconfirmed execution=%s task=%s "
                "runtime_instance=%s",
                row.id if row is not None else None,
                row.runtime_task_id if row is not None else None,
                runtime_instance_id,
            )
        else:
            row = loop_item_execution_service.claim_next_for_device(
                db,
                execution_device_id=execution_target_id,
                runtime_device_id=runtime_device_id,
                environment=environment,
                runtime_instance_id=runtime_instance_id,
                owner_user_id=owner_user_id,
            )
        if row is None:
            return {"success": True, "task": None}

        try:
            payload = loop_item_execution_service.build_executor_runtime_payload(
                db,
                execution=row,
                execution_target_id=execution_target_id,
                executor_device_id=runtime_device_id,
            )
        except (WeworkRuntimeConfigurationError, WeworkExecutionProfileError) as exc:
            loop_item_execution_service.fail_runtime_preflight(
                db,
                execution_id=row.id,
                error=str(exc),
                note="runtime_configuration_unavailable",
            )
            return {"success": False, "error": str(exc), "task": None}

        runtime_task_id = row.runtime_task_id
        if not runtime_task_id:
            loop_item_execution_service.fail_runtime_preflight(
                db,
                execution_id=row.id,
                error="Claimed execution has no Runtime task identity",
                note="runtime_identity_unavailable",
            )
            return {
                "success": False,
                "error": "Claimed execution has no Runtime task identity",
                "task": None,
            }
        payload["taskId"] = runtime_task_id
        execution_request = payload.get("executionRequest")
        if isinstance(execution_request, dict):
            execution_request["task_id"] = runtime_task_id
            execution_request["subtask_id"] = f"{runtime_task_id}-execution-{row.id}"

        # Claiming and materializing a payload does not prove that the
        # Socket.IO acknowledgement reached the Executor. Keep
        # start_requested_at unset until the Executor confirms that Runtime
        # accepted the create request, so a lost pull response remains safe to
        # recover and redeliver.
        loop_item_execution_service._bind_issue_execution_task(
            db,
            execution=row,
        )
        db.commit()

        return {
            "success": True,
            "task": {
                "execution_id": row.id,
                "runtime_task_id": runtime_task_id,
                "payload": payload,
                "prompt": _runtime_prompt(payload),
            },
        }


def pull_execution(
    *,
    owner_user_id: int,
    execution_target_id: str,
    runtime_device_id: str,
    runtime_instance_id: str,
    environment: str,
    runner_catalog: dict | None = None,
) -> dict[str, Any]:
    """Atomically claim and materialize one execution for this Runtime."""

    if runner_catalog is not None:
        from pydantic import ValidationError

        from app.schemas.runner_routing import RunnerCatalog
        from app.services.device.identity import resolve_owned_device_alias
        from app.services.runner_routing import save_catalog

        try:
            report = RunnerCatalog.model_validate(runner_catalog)
        except ValidationError:
            return {"success": False, "error": "Invalid runner capability report"}
        with get_db_session() as db:
            device = resolve_owned_device_alias(
                db, user_id=owner_user_id, device_id=execution_target_id
            )
            if device is None:
                return {"success": False, "error": "Runner is no longer authorized"}
            save_catalog(db, device, report)
            db.commit()

    runtime_lock = f"robot_exec:{owner_user_id}:runtime:{runtime_instance_id}"
    with distributed_lock.acquire_context(
        runtime_lock,
        expire_seconds=DEVICE_PULL_LOCK_SECONDS,
    ) as runtime_acquired:
        result = (
            _claim_execution(
                owner_user_id=owner_user_id,
                execution_target_id=execution_target_id,
                runtime_device_id=runtime_device_id,
                runtime_instance_id=runtime_instance_id,
                environment=environment,
            )
            if runtime_acquired
            else {"success": True, "task": None}
        )
    with get_db_session() as db:
        result["workspace_cleanup_intents"] = pull_due(
            db,
            owner_user_id=owner_user_id,
            runtime_device_id=runtime_device_id,
        )
    return result


def acknowledge_execution(
    *,
    owner_user_id: int,
    runtime_device_id: str,
    runtime_instance_id: str,
    execution_id: int,
    runtime_task_id: str,
    accepted: bool,
    prompt: str | None,
    error: str | None,
) -> dict[str, Any]:
    """Record the Executor's definitive response to a pulled Runtime create."""

    with get_db_session() as db:
        row = db.get(LoopItemExecution, execution_id)
        if (
            row is None
            or row.executor_owner_user_id != owner_user_id
            or row.runtime_device_id != runtime_device_id
            or row.runtime_instance_id != runtime_instance_id
            or row.runtime_task_id != runtime_task_id
        ):
            return {"success": False, "error": "Execution identity mismatch"}

        if accepted:
            if row.status != "claimed":
                return {
                    "success": row.status
                    in {
                        "running",
                        "cancel_requested",
                        "completed",
                        "failed",
                        "cancelled",
                    }
                }
            accepted_row = loop_item_execution_service.accept_runtime_and_open_activity(
                db,
                execution_id=execution_id,
                runtime_device_id=runtime_device_id,
                runtime_task_id=runtime_task_id,
                prompt=prompt,
            )
            return {"success": accepted_row is not None}

        failed = loop_item_execution_service.fail(
            db,
            execution_id=execution_id,
            error=error or "Executor rejected runtime task creation",
            note="runtime_start_rejected",
            requeue=False,
            expected_status=row.status,
            expected_version=row.version,
            termination_reason="runtime_start_rejected",
        )
        logger.warning(
            "[RobotQueue] Executor rejected pulled execution=%s device=%s error=%s",
            execution_id,
            runtime_device_id,
            error,
        )
        return {"success": failed is not None}
