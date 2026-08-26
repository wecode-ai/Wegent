# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Device-initiated cloud execution delivery.

The connected Executor owns the transport, so it pulls work through its current
Socket.IO connection. MySQL remains the durable queue and the existing
LoopItemExecution service owns claiming, leases, and runtime state.
"""

import logging
from typing import Any

from app.core.distributed_lock import distributed_lock
from app.db.session import get_db_session
from app.models.loop_item_execution import LoopItemExecution
from app.services.device.capacity import validate_runtime_capacity_observation_sync
from app.services.loop_item_executions.service import (
    WeworkRuntimeConfigurationError,
    loop_item_execution_service,
)

logger = logging.getLogger(__name__)

DEVICE_PULL_LOCK_SECONDS = 30


def _runtime_prompt(payload: dict[str, Any]) -> str | None:
    request = payload.get("executionRequest")
    if not isinstance(request, dict):
        return None
    prompt = request.get("prompt")
    return prompt if isinstance(prompt, str) else None


def _claim_cloud_execution(
    *,
    owner_user_id: int,
    device_id: str,
    runtime_instance_id: str,
    runtime_capacity: dict[str, Any] | None,
) -> dict[str, Any]:
    with get_db_session() as db:
        capacity = validate_runtime_capacity_observation_sync(
            db,
            owner_user_id=owner_user_id,
            device_id=device_id,
            runtime_instance_id=runtime_instance_id,
            runtime_capacity=runtime_capacity,
        )
        if capacity is None:
            return {"success": True, "task": None}

        row = loop_item_execution_service.claim_next_for_device(
            db,
            execution_device_id=device_id,
            environment="cloud",
            runtime_instance_id=runtime_instance_id,
            device_capacity=capacity.limit,
            runtime_active=capacity.active,
            runtime_active_task_ids=capacity.active_task_ids,
            owner_user_id=owner_user_id,
        )
        if row is None:
            return {"success": True, "task": None}

        try:
            payload = loop_item_execution_service.build_runtime_payload(
                db,
                execution=row,
            )
        except WeworkRuntimeConfigurationError as exc:
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
            execution_request["subtask_id"] = f"{runtime_task_id}-assistant"

        advanced = loop_item_execution_service.mark_start_requested(
            db,
            execution_ids=[row.id],
        )
        if advanced != 1:
            return {"success": True, "task": None}

        return {
            "success": True,
            "task": {
                "execution_id": row.id,
                "runtime_task_id": runtime_task_id,
                "payload": payload,
                "prompt": _runtime_prompt(payload),
            },
        }


def pull_cloud_execution(
    *,
    owner_user_id: int,
    device_id: str,
    runtime_instance_id: str,
    runtime_capacity: dict[str, Any] | None,
) -> dict[str, Any]:
    """Atomically claim and materialize one cloud execution for a device."""

    runtime_lock = f"robot_exec:{owner_user_id}:runtime:{runtime_instance_id}"
    with distributed_lock.acquire_context(
        runtime_lock,
        expire_seconds=DEVICE_PULL_LOCK_SECONDS,
    ) as runtime_acquired:
        if not runtime_acquired:
            return {"success": True, "task": None}
        return _claim_cloud_execution(
            owner_user_id=owner_user_id,
            device_id=device_id,
            runtime_instance_id=runtime_instance_id,
            runtime_capacity=runtime_capacity,
        )


def acknowledge_cloud_execution(
    *,
    owner_user_id: int,
    device_id: str,
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
            or row.runtime_device_id != device_id
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
                runtime_device_id=device_id,
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
            device_id,
            error,
        )
        return {"success": failed is not None}
