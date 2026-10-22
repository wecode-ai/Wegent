# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Human Issue dispatch notifications and optional runtime task bindings."""

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
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.services.delivery.service import delivery_service
from app.services.wework_notifications import create_notification

DIRECT_HUMAN_ROUND_ID = "direct"


def human_task_binding(db: Session, item: LoopItem, user_id: int) -> dict | None:
    """Expose the current assignee's task identity independently of status actions."""
    if item.assignee_user_id != user_id:
        return None
    project = db.get(CloudProject, item.cloud_project_id)
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    if (
        project is None
        or project.task_provider != "local"
        or any(
            metadata.get(key)
            for key in ("workflow", "external_index", "external_shadow")
        )
    ):
        return None
    from app.services.issue_assignments import issue_assignment_service

    active = issue_assignment_service.active_for_issue(db, item.id)
    if len(active) != 1:
        return None
    assignment = active[0]
    if (
        assignment.member_type != "human"
        or assignment.metadata.get("trigger") == "default"
        or assignment.workflow_step
        or assignment.member_id != str(item.assignee_user_id)
    ):
        return None
    if assignment.metadata.get("trigger") == "collaboration_round":
        return _round_human_task_binding(db, item)
    return {
        "humanAssignmentId": direct_human_assignment_id(
            issue_id=item.id, assignment_id=assignment.id
        ),
        "dispatchId": f"direct-human:{assignment.id}",
        "dispatchRoundId": DIRECT_HUMAN_ROUND_ID,
        "assignmentId": assignment.id,
    }


def _round_human_task_binding(db: Session, item: LoopItem) -> dict | None:
    activities = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == str(item.cloud_project_id),
            ProjectChatMessage.task_id == item.id,
        )
        .order_by(ProjectChatMessage.created_at.desc(), ProjectChatMessage.id.desc())
        .all()
    )
    for activity in activities:
        metadata = activity.metadata_json
        if not isinstance(metadata, dict):
            continue
        if metadata.get("activity_type") != "manager_assignment":
            continue
        members = metadata.get("dispatch_assignments")
        if not isinstance(members, list):
            return None
        for member in members:
            if not isinstance(member, dict):
                continue
            if member.get("assignee_type") == "human" and str(
                member.get("human_user_id")
            ) == str(item.assignee_user_id):
                binding = {
                    "humanAssignmentId": member.get("human_assignment_id"),
                    "dispatchId": metadata.get("dispatch_id"),
                    "dispatchRoundId": metadata.get("coordination_round_id"),
                    "assignmentId": member.get("assignment_id"),
                }
                return binding if all(binding.values()) else None
        return None
    return None


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
    actor = db.get(User, actor_user_id)
    notify_collaboration_human_assignment(
        db,
        project=project,
        issue=issue,
        human=human,
        actor_user_id=actor_user_id,
        actor_name=actor.user_name if actor else "",
        human_assignment_id=human_assignment_id,
        dispatch_id=f"direct-human:{assignment_id}",
        round_id=DIRECT_HUMAN_ROUND_ID,
        assignment_id=assignment_id,
        task_title=resolved_title,
        instructions=resolved_instructions or resolved_title,
        workflow_stage_id=None,
        body="这个 Issue 已分配给你。打开后可直接处理，或按需使用 AI 辅助。",
        action="open_issue",
    )


def notify_collaboration_human_assignment(
    db: Session,
    *,
    project: CloudProject,
    issue: LoopItem,
    human: User,
    actor_user_id: int,
    actor_name: str,
    human_assignment_id: str,
    dispatch_id: str,
    round_id: str,
    assignment_id: str,
    task_title: str,
    instructions: str,
    workflow_stage_id: str | None,
    body: str = "负责人向你分配了协作任务。",
    action: str = "create_personal_task",
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
            **({"actorName": actor_name} if actor_name else {}),
            "action": action,
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
    assignment_bindings = [
        row
        for row in bindings
        if isinstance(row.metadata_json, dict)
        and row.metadata_json.get("human_assignment_id") == human_assignment_id
    ]
    if not assignment_bindings:
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
            Delivery.source_task_binding_id.in_(
                [str(binding.id) for binding in assignment_bindings]
            ),
            Delivery.status == "delivered",
        )
        .order_by(Delivery.delivered_at.desc(), Delivery.created_at.desc())
        .first()
    )
    binding = (
        next(
            binding
            for binding in assignment_bindings
            if str(binding.id) == delivery.source_task_binding_id
        )
        if delivery is not None
        else assignment_bindings[0]
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
