# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Route Issue execution cancellation to the Runtime that owns the work."""

from app.models.loop_item_execution import LoopItemExecution
from app.services.runtime_cancellation import RuntimeCancellationTarget


def execution_cancellation_target(
    execution: LoopItemExecution,
) -> RuntimeCancellationTarget | None:
    """Preserve the queue's transport route and Runtime payload identities."""

    device_id = execution.execution_device_id or execution.runtime_device_id or ""
    owner_user_id = execution.executor_owner_user_id
    if not execution.runtime_task_id or not device_id or not owner_user_id:
        return None
    return RuntimeCancellationTarget(
        owner_user_id=owner_user_id,
        device_id=device_id,
        task_id=execution.runtime_task_id,
        runtime_device_id=execution.runtime_device_id or "",
    )


def request_execution_cancellations(
    executions: list[LoopItemExecution],
) -> None:
    """Send cancellation requests without taking ownership of execution."""

    if not executions:
        return
    from app.tasks.robot_queue_tasks import emit_runtime_cancels

    emit_runtime_cancels(executions)
