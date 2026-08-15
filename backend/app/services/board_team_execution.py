# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Dispatch Team-assigned board tasks through the native Wegent pipeline."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.services.project_automation_managed_execution import (
    project_automation_managed_execution_service,
)


def _execution_prompt(
    db: Session,
    *,
    item: LoopItem,
    execution: LoopItemExecution,
) -> tuple[str, str]:
    from app.services.loop_item_executions.service import loop_item_execution_service

    context = loop_item_execution_service.resolve_task_context(
        db,
        execution=execution,
        user_id=execution.executor_owner_user_id,
    )
    if context is None:
        raise RuntimeError("Assigned board task context is unavailable")
    title = context.title or "Board task"
    description = context.description.strip()
    task = f"请执行看板任务 {item.id}：{title}。"
    if description:
        task = f"{task}\n\n任务说明：\n{description}"
    prompt = (
        f"{task}\n\n请通过 Wegent 看板工具读取最新任务上下文；"
        "执行期间以看板任务及其执行记录为状态真值。"
    )
    return prompt, title


async def dispatch_board_team_assignment(
    db: Session,
    *,
    item: LoopItem,
    user: User,
) -> LoopItemExecution | None:
    """Dispatch the newest undispatched Team execution for one assigned item."""

    if not item.assignee_team_id:
        return None
    execution = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.team_id == item.assignee_team_id,
            LoopItemExecution.status == "queued",
        )
        .order_by(LoopItemExecution.id.desc())
        .first()
    )
    if execution is None or execution.backend_task_id:
        return execution
    team = db.get(Kind, item.assignee_team_id)
    if team is None or team.kind != "Team" or not team.is_active:
        raise RuntimeError("Assigned Wegent Team is unavailable")
    prompt, title = _execution_prompt(db, item=item, execution=execution)
    await project_automation_managed_execution_service.dispatch_board_team(
        db=db,
        owner=user,
        team=team,
        prompt=prompt,
        title=title,
        project_id=str(item.cloud_project_id),
        loop_item_id=item.id,
        execution_id=execution.id,
    )
    db.expire_all()
    return db.get(LoopItemExecution, execution.id)


def request_execution_cancellations(
    executions: list[LoopItemExecution],
) -> None:
    """Route cancellation to each execution's real runtime."""

    runtime_executions = [
        execution
        for execution in executions
        if execution.runtime_device_id and execution.runtime_task_id
    ]
    if runtime_executions:
        from app.tasks.robot_queue_tasks import emit_runtime_cancels

        emit_runtime_cancels(runtime_executions)
    from app.tasks.project_automation_tasks import (
        cancel_managed_board_team_execution,
    )

    for execution in executions:
        if (
            execution.team_id is not None
            and execution.backend_task_id is not None
            and execution.executor_owner_user_id
        ):
            cancel_managed_board_team_execution.delay(
                task_id=execution.backend_task_id,
                user_id=execution.executor_owner_user_id,
            )
