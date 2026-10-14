# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep Executor-owned member sessions addressable after their round finishes."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItemTaskBinding, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.delivery import LoopItemTaskBind
from app.schemas.project_chat import LoopItemExecutionAssignmentStatus
from app.services.loop_item_executions.service import runtime_device_identity_ids
from app.services.loop_items.service import loop_item_service


def bind_collaboration_member_session(
    db: Session,
    *,
    project_id: int,
    values: LoopItemExecutionAssignmentStatus,
    assignment: dict[str, Any],
) -> LoopItemTaskBinding:
    executions = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.cloud_project_id == str(project_id),
            LoopItemExecution.loop_item_id == values.loop_item_id,
        )
        .order_by(LoopItemExecution.id.desc())
        .all()
    )
    dispatch = next(
        (
            row
            for row in executions
            if row.runtime_origin_context.get("dispatch_id") == values.dispatch_id
        ),
        None,
    )
    if dispatch is None:
        raise HTTPException(409, "The collaboration dispatch binding is unavailable")
    expected_task_id = (
        f"{dispatch.runtime_task_id}-member-{values.round_id}-{values.assignment_id}"
    )
    devices = runtime_device_identity_ids(
        db, dispatch.runtime_device_id, owner_user_id=dispatch.executor_owner_user_id
    )
    if (
        values.runtime_task_id != expected_task_id
        or values.runtime_device_id not in devices
    ):
        raise HTTPException(409, "The member session does not match its dispatch")
    agent = db.get(ProjectChatAgent, str(assignment.get("agent_id") or ""))
    if agent is None or str(agent.cloud_project_id) != str(project_id):
        raise HTTPException(409, "The collaboration member is unavailable")
    return loop_item_service.bind_execution_task(
        db,
        item_id=values.loop_item_id,
        values=LoopItemTaskBind(
            deviceId=values.runtime_device_id,
            taskId=values.runtime_task_id,
            taskTitle=str(assignment.get("task_title") or ""),
            dispatchId=values.dispatch_id,
            dispatchRoundId=values.round_id,
            assignmentId=values.assignment_id,
        ),
        user_id=dispatch.executor_owner_user_id,
        commit=False,
    )
