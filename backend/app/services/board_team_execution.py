# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Dispatch Wegent-runtime board robots through the native Wegent pipeline."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.services.loop_item_executions.profile import build_project_robot_user_input
from app.services.project_automation_managed_execution import (
    project_automation_managed_execution_service,
)


def _execution_prompt(
    db: Session,
    *,
    item: LoopItem,
    execution: LoopItemExecution,
    execution_prompt: str,
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
    prompt = build_project_robot_user_input(
        project_id=str(item.cloud_project_id),
        task_id=item.id,
        execution_id=execution.id,
        execution_prompt=execution_prompt,
    )
    return prompt, title


async def dispatch_board_team_assignment(
    db: Session,
    *,
    item: LoopItem,
    user: User,
) -> LoopItemExecution | None:
    """Dispatch the newest Wegent-runtime execution for one assigned robot."""

    del user

    if not item.assignee_agent_id:
        return None
    agent = db.get(ProjectChatAgent, item.assignee_agent_id)
    if agent is None:
        return None
    from app.services.project_chat.service import bot_config

    config = bot_config(agent)
    if config.get("runtime") != "wegent" or config.get("wegent_team_id") is None:
        return None
    team_id = int(config["wegent_team_id"])
    execution = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.agent_id == item.assignee_agent_id,
            LoopItemExecution.team_id == team_id,
            LoopItemExecution.status == "queued",
        )
        .order_by(LoopItemExecution.id.desc())
        .first()
    )
    if execution is None:
        return None
    return await dispatch_board_robot_execution(db, execution_id=execution.id)


async def dispatch_board_robot_execution(
    db: Session,
    *,
    execution_id: int,
) -> LoopItemExecution | None:
    """Idempotently activate one exact Wegent-runtime board execution."""

    execution = (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.id == execution_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if execution is None:
        return None
    if execution.status != "queued" or execution.backend_task_id:
        return execution
    if not execution.agent_id or execution.team_id is None:
        raise RuntimeError("Board robot execution has no Wegent runtime target")

    item = db.get(LoopItem, execution.loop_item_id)
    agent = db.get(ProjectChatAgent, execution.agent_id)
    if (
        item is None
        or agent is None
        or item.cloud_project_id != execution.cloud_project_id
        or item.assignee_agent_id != agent.id
        or agent.cloud_project_id != execution.cloud_project_id
        or agent.status != "active"
    ):
        raise RuntimeError("Board robot execution no longer matches its assignment")

    from app.services.project_chat.service import bot_config

    config = bot_config(agent)
    if (
        config.get("runtime") != "wegent"
        or config.get("wegent_team_id") is None
        or int(config["wegent_team_id"]) != execution.team_id
    ):
        raise RuntimeError("Board robot Wegent runtime configuration changed")

    team = db.get(Kind, execution.team_id)
    owner = db.get(User, execution.executor_owner_user_id)
    if team is None or team.kind != "Team" or not team.is_active:
        raise RuntimeError("Assigned Wegent Team is unavailable")
    if owner is None:
        raise RuntimeError("Board robot execution owner is unavailable")

    prompt, title = _execution_prompt(
        db,
        item=item,
        execution=execution,
        execution_prompt=str(config.get("execution_prompt") or ""),
    )
    await project_automation_managed_execution_service.dispatch_board_team(
        db=db,
        owner=owner,
        agent=agent,
        team=team,
        prompt=prompt,
        title=title,
        project_id=str(item.cloud_project_id),
        loop_item_id=item.id,
        execution_id=execution.id,
    )
    db.expire_all()
    return db.get(LoopItemExecution, execution_id)


def schedule_board_robot_execution(
    db: Session,
    execution: LoopItemExecution,
) -> None:
    """Schedule runtime activation after the assignment transaction commits."""

    if (
        execution.status != "queued"
        or not execution.agent_id
        or execution.team_id is None
        or execution.backend_task_id
    ):
        return
    from app.tasks.project_automation_tasks import dispatch_board_robot_execution

    try:
        dispatch_board_robot_execution.delay(execution_id=execution.id)
    except Exception as exc:
        from app.services.loop_item_executions.service import (
            loop_item_execution_service,
        )

        loop_item_execution_service.fail(
            db,
            execution_id=execution.id,
            error=str(exc) or "Wegent runtime activation enqueue failed",
            termination_reason="wegent_runtime_activation_enqueue_failed",
        )
        raise


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
