# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Expose a resumed manager before it makes a decision or asks for input."""

import hashlib

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_is_unset
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import LoopItemExecutionManagerStatus
from app.services.collaboration_human_assignments import (
    collaboration_human_assignment_status,
)
from app.services.collaboration_manager_decisions import _require_manager_dispatch
from app.services.collaboration_round_assignment import assign_round_owner
from app.services.device.identity import same_owned_device
from app.services.loop_item_events import publish_loop_item_changed
from app.services.project_chat.runtime_binding import (
    bind_collaboration_manager_activity,
    collaboration_manager_task_id,
    resumed_manager_task_id,
)


def project_collaboration_manager_activity(
    db: Session,
    *,
    project_id: int,
    user_id: int,
    values: LoopItemExecutionManagerStatus,
) -> tuple[ProjectChatMessage, bool]:
    """Bind the exact next manager session and return ownership once per round."""
    item = (
        db.query(LoopItem)
        .filter_by(
            id=values.loop_item_id,
            cloud_project_id=str(project_id),
            resource_type="task",
        )
        .filter(loop_datetime_is_unset(LoopItem.deleted_at))
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if item is None:
        raise HTTPException(404, "Issue not found")
    rounds = (
        db.query(ProjectChatMessage)
        .filter_by(project_id=str(project_id), task_id=item.id)
        .filter(loop_datetime_is_unset(ProjectChatMessage.deleted_at))
        .all()
    )
    previous = next(
        (
            row
            for row in rounds
            if (row.metadata_json or {}).get("activity_type") == "manager_assignment"
            and row.metadata_json.get("dispatch_id") == values.dispatch_id
            and row.metadata_json.get("coordination_round_id") == values.round_id
        ),
        None,
    )
    if previous is None:
        raise HTTPException(409, "Collaboration round was not found")
    manager, dispatch = _require_manager_dispatch(
        db,
        project_id=project_id,
        item=item,
        dispatch_id=values.dispatch_id,
        manager_agent_id=previous.agent_id,
    )
    if dispatch.executor_owner_user_id != user_id or not same_owned_device(
        db,
        user_id=user_id,
        left_device_id=dispatch.runtime_device_id,
        right_device_id=values.runtime_device_id,
    ):
        raise HTTPException(403, "Manager Runtime is not owned by the caller")
    previous_task = collaboration_manager_task_id(db, dispatch, previous)
    expected_task = resumed_manager_task_id(previous_task, values.round_id)
    assignments = previous.metadata_json.get("dispatch_assignments") or []
    if values.runtime_task_id != expected_task or not _round_finished(
        db, project_id, item.id, assignments
    ):
        raise HTTPException(409, "Manager resume does not match a finished round")
    identity = f"manager-resume:{values.dispatch_id}:{values.round_id}"
    message_id = hashlib.sha256(identity.encode()).hexdigest()
    existing = next((row for row in rounds if row.message_id == message_id), None)
    if existing is not None:
        return existing, False
    activity = _new_manager_activity(
        project_id, item.id, manager, values, message_id, expected_task
    )
    db.add(activity)
    db.flush()
    bind_collaboration_manager_activity(
        db, dispatch=dispatch, activity=activity, item=item
    )
    assign_round_owner(
        db,
        item=item,
        assignments=[
            {
                "assignee_type": "agent",
                "agent_id": manager.id,
                "agent_name": activity.sender_name,
            }
        ],
        user_id=dispatch.assigner_user_id,
    )
    db.commit()
    publish_loop_item_changed(
        db, item=item, reason="collaboration_manager_resume", actor_user_id=user_id
    )
    db.refresh(activity)
    return activity, True


def _round_finished(
    db: Session, project_id: int, item_id: str, assignments: list[dict]
) -> bool:
    if not assignments:
        return False
    for entry in assignments:
        if entry.get("assignee_type") == "human":
            state = collaboration_human_assignment_status(
                db,
                project_id=project_id,
                issue_id=item_id,
                human_assignment_id=str(entry.get("human_assignment_id") or ""),
            )["status"]
        else:
            state = entry.get("status")
        if state not in {"completed", "failed", "cancelled"}:
            return False
    return True


def _new_manager_activity(
    project_id: int,
    item_id: str,
    manager: ProjectChatAgent,
    values: LoopItemExecutionManagerStatus,
    message_id: str,
    expected_task: str,
) -> ProjectChatMessage:
    return ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project_id),
        task_id=item_id,
        sender_type="agent",
        sender_id=manager.id,
        sender_name=manager.title or manager.name or "AI manager",
        message_type="text",
        content="",
        metadata_json={
            "activity_type": "manager_execution",
            "dispatch_role": "manager",
            "dispatch_id": values.dispatch_id,
            "coordination_round_id": values.round_id,
            "manager_runtime_task_id": expected_task,
        },
        agent_id=manager.id,
        status="pending",
    )
