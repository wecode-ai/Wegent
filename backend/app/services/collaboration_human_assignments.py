# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Personal runtime tasks created from human Issue dispatch notifications."""

from __future__ import annotations

from uuid import NAMESPACE_URL, uuid5

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    Delivery,
    LoopItem,
    LoopItemTaskBinding,
    loop_datetime_is_unset,
)
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.services.delivery.service import delivery_service
from app.services.wework_notifications import create_notification

DIRECT_HUMAN_ROUND_ID = "direct"


def collaboration_human_assignment_id(
    *, dispatch_id: str, round_id: str, assignment_id: str
) -> str:
    """Return the stable identity shared by notification, Task and barrier."""

    return str(
        uuid5(
            NAMESPACE_URL,
            f"wegent:collaboration-human:{dispatch_id}:{round_id}:{assignment_id}",
        )
    )


def direct_human_assignment_id(*, issue_id: str, assignment_id: str) -> str:
    """Return the stable identity for a direct human Issue assignment."""

    return str(
        uuid5(
            NAMESPACE_URL,
            f"wegent:direct-human:{issue_id}:{assignment_id}",
        )
    )


def notify_direct_human_assignment(
    db: Session,
    *,
    project: CloudProject,
    issue: LoopItem,
    human: User,
    actor_user_id: int,
    assignment_id: str,
    task_title: str | None = None,
    instructions: str | None = None,
) -> None:
    """Notify a direct assignee without creating or mutating another Issue."""

    resolved_title = (task_title or issue.title).strip()
    resolved_instructions = (instructions or issue.description or "").strip()
    human_assignment_id = direct_human_assignment_id(
        issue_id=issue.id,
        assignment_id=assignment_id,
    )
    notify_collaboration_human_assignment(
        db,
        project=project,
        issue=issue,
        human=human,
        actor_user_id=actor_user_id,
        human_assignment_id=human_assignment_id,
        dispatch_id=f"direct-human:{assignment_id}",
        round_id=DIRECT_HUMAN_ROUND_ID,
        assignment_id=assignment_id,
        task_title=resolved_title,
        instructions=resolved_instructions or resolved_title,
        workflow_stage_id=None,
        body="这个 Issue 已分配给你。打开通知可创建个人任务并提交交付。",
    )


def notify_collaboration_human_assignment(
    db: Session,
    *,
    project: CloudProject,
    issue: LoopItem,
    human: User,
    actor_user_id: int,
    human_assignment_id: str,
    dispatch_id: str,
    round_id: str,
    assignment_id: str,
    task_title: str,
    instructions: str,
    workflow_stage_id: str | None,
    body: str = "负责人向你分配了协作任务。",
) -> None:
    """Notify the person without creating a board child Issue."""

    existing = (
        db.query(WeworkNotification)
        .filter(
            WeworkNotification.user_id == human.id,
            WeworkNotification.kind == "issue_dispatch_assignment",
        )
        .all()
    )
    if any(
        isinstance(notification.payload, dict)
        and notification.payload.get("humanAssignmentId") == human_assignment_id
        for notification in existing
    ):
        return
    create_notification(
        db,
        user_id=human.id,
        actor_user_id=actor_user_id,
        kind="issue_dispatch_assignment",
        title=f"新任务：{task_title}",
        body=body,
        project_id=str(project.id),
        item_id=issue.id,
        payload={
            "action": "create_personal_task",
            "projectId": str(project.id),
            "itemId": issue.id,
            "issueId": issue.id,
            "dispatchTaskId": human_assignment_id,
            "humanAssignmentId": human_assignment_id,
            "dispatchId": dispatch_id,
            "roundId": round_id,
            "assignmentId": assignment_id,
            "taskTitle": task_title,
            "instructions": instructions,
            "workflowStageId": workflow_stage_id,
            "idempotencyKey": f"human-assignment:{human_assignment_id}",
        },
    )


def collaboration_human_assignment_status(
    db: Session,
    *,
    project_id: int,
    issue_id: str,
    human_assignment_id: str,
) -> dict[str, object]:
    """Project the personal Task and its Delivery onto one round assignment."""

    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.cloud_project_id == str(project_id),
            LoopItemTaskBinding.loop_item_id == issue_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .order_by(LoopItemTaskBinding.linked_at.desc())
        .all()
    )
    binding = next(
        (
            row
            for row in bindings
            if isinstance(row.metadata_json, dict)
            and row.metadata_json.get("human_assignment_id") == human_assignment_id
        ),
        None,
    )
    if binding is None:
        return {
            "assignee_type": "human",
            "work_id": f"human_assignment:{human_assignment_id}",
            "human_assignment_id": human_assignment_id,
            "status": "queued",
            "result": "",
            "error": "",
        }

    delivery = (
        db.query(Delivery)
        .filter(
            Delivery.loop_item_id == issue_id,
            Delivery.source_task_binding_id == str(binding.id),
            Delivery.status == "delivered",
        )
        .order_by(Delivery.delivered_at.desc(), Delivery.created_at.desc())
        .first()
    )
    result = delivery_service.read_markdown(delivery) if delivery is not None else ""
    return {
        "assignee_type": "human",
        "work_id": f"human_assignment:{human_assignment_id}",
        "human_assignment_id": human_assignment_id,
        "status": "completed" if delivery is not None else "running",
        "human_user_id": binding.task_user_id,
        "runtime_device_id": binding.device_id,
        "runtime_task_id": binding.task_id,
        "delivery_id": delivery.id if delivery is not None else None,
        "result": result,
        "error": "",
    }
