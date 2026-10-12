# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project the Executor-owned collaboration member state into Issue activity."""

import hashlib
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import LoopItemExecutionAssignmentStatus
from app.services.project_chat.service import project_chat_service


def _activity_id(dispatch_id: str, round_id: str, assignment_id: str) -> str:
    identity = "\0".join((dispatch_id, round_id, assignment_id))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _manager_assignment(
    db: Session,
    *,
    project_id: int,
    values: LoopItemExecutionAssignmentStatus,
) -> tuple[ProjectChatMessage, dict[str, Any], int] | None:
    messages = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == str(project_id),
            ProjectChatMessage.task_id == values.loop_item_id,
        )
        .order_by(ProjectChatMessage.created_at.desc())
        .all()
    )
    for message in messages:
        metadata = message.metadata_json
        if not isinstance(metadata, dict):
            continue
        if (
            metadata.get("activity_type") != "manager_assignment"
            or metadata.get("dispatch_id") != values.dispatch_id
            or metadata.get("coordination_round_id") != values.round_id
        ):
            continue
        assignments = metadata.get("dispatch_assignments")
        if not isinstance(assignments, list):
            break
        for index, assignment in enumerate(assignments):
            if (
                isinstance(assignment, dict)
                and assignment.get("assignment_id") == values.assignment_id
                and assignment.get("assignee_type") == "agent"
            ):
                return message, assignment, index
        break
    return None


def project_collaboration_member_activity(
    db: Session,
    *,
    project_id: int,
    values: LoopItemExecutionAssignmentStatus,
) -> tuple[ProjectChatMessage, bool]:
    """Create or update one member execution card without coordinating the round."""

    message_id = _activity_id(
        values.dispatch_id,
        values.round_id,
        values.assignment_id,
    )
    message = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.message_id == message_id,
            ProjectChatMessage.project_id == str(project_id),
            ProjectChatMessage.task_id == values.loop_item_id,
        )
        .one_or_none()
    )
    manager_assignment = _manager_assignment(
        db,
        project_id=project_id,
        values=values,
    )
    if manager_assignment is None and message is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Collaboration assignment was not found",
        )
    if manager_assignment is not None:
        manager_message, assignment, assignment_index = manager_assignment
    else:
        manager_message = None
        assignment = {
            "assignment_id": values.assignment_id,
            "agent_id": message.agent_id,
            "agent_name": message.sender_name,
            "task_title": (message.metadata_json or {}).get("workflow_task_title"),
            "workflow_stage_id": (message.metadata_json or {}).get("workflow_stage_id"),
        }
        assignment_index = -1
    previous_assignment = dict(assignment)
    assignment = {
        **assignment,
        "status": values.status,
        "runtime_device_id": values.runtime_device_id,
        "runtime_task_id": values.runtime_task_id,
        "result": values.result,
        "error": values.error,
    }
    if manager_message is not None:
        manager_metadata = dict(manager_message.metadata_json or {})
        assignments = list(manager_metadata["dispatch_assignments"])
        assignments[assignment_index] = assignment
        manager_message.metadata_json = {
            **manager_metadata,
            "dispatch_assignments": assignments,
        }
    created = message is None
    metadata = {
        "activity_type": "member_execution",
        "dispatch_role": "member",
        "dispatch_id": values.dispatch_id,
        "coordination_round_id": values.round_id,
        "assignment_id": values.assignment_id,
        "workflow_stage_id": assignment.get("workflow_stage_id"),
        "workflow_task_title": assignment.get("task_title"),
        "run_status": values.status,
        "error": values.error,
    }
    changed = created or any(
        (
            previous_assignment.get("status") != values.status,
            previous_assignment.get("runtime_device_id") != values.runtime_device_id,
            previous_assignment.get("runtime_task_id") != values.runtime_task_id,
            previous_assignment.get("result") != values.result,
            previous_assignment.get("error") != values.error,
        )
    )
    if message is None:
        message = ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=str(project_id),
            task_id=values.loop_item_id,
            sender_type="agent",
            sender_id=str(
                assignment.get("agent_id") or assignment.get("assignee_id") or ""
            ),
            sender_name=str(assignment.get("agent_name") or "AI"),
            message_type="text",
            content=values.result,
            metadata_json=metadata,
            agent_id=str(assignment.get("agent_id") or ""),
            runtime_device_id=values.runtime_device_id,
            runtime_task_id=values.runtime_task_id,
            runtime_activity_key=project_chat_service._runtime_activity_key(
                values.runtime_device_id,
                values.runtime_task_id,
                "",
            )
            or "",
            status="streaming" if values.status == "running" else values.status,
        )
        db.add(message)
    elif changed:
        message.content = values.result
        message.metadata_json = {**dict(message.metadata_json or {}), **metadata}
        message.runtime_device_id = values.runtime_device_id
        message.runtime_task_id = values.runtime_task_id
        message.status = "streaming" if values.status == "running" else values.status
    if changed:
        db.commit()
        db.refresh(message)
    return message, changed
