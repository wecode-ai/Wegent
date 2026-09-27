# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Route Issue execution cancellation to the Runtime that owns the work."""

from app.models.loop_item_execution import LoopItemExecution


def request_execution_cancellations(
    executions: list[LoopItemExecution],
) -> None:
    """Send cancellation requests without taking ownership of execution."""

    if not executions:
        return
    from app.tasks.robot_queue_tasks import emit_runtime_cancels

    emit_runtime_cancels(executions)
