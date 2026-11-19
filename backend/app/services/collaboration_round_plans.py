# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Read and compare an accepted collaboration round without materializing it."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import LoopItemExecutionBatchCreate


def round_assignment_message(
    db: Session, *, item: LoopItem, dispatch_id: str, round_id: str
) -> ProjectChatMessage | None:
    """Read the immutable plan under the caller's Issue and dispatch locks."""
    activities = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == str(item.cloud_project_id),
            ProjectChatMessage.task_id == item.id,
        )
        .order_by(ProjectChatMessage.created_at.desc())
        .all()
    )
    return next(
        (
            message
            for message in activities
            if isinstance(message.metadata_json, dict)
            and message.metadata_json.get("activity_type") == "manager_assignment"
            and message.metadata_json.get("dispatch_id") == dispatch_id
            and message.metadata_json.get("coordination_round_id") == round_id
        ),
        None,
    )


def same_batch_request(
    message: ProjectChatMessage,
    values: LoopItemExecutionBatchCreate,
    manager_agent_id: str,
) -> bool:
    metadata = message.metadata_json
    if (
        message.agent_id != manager_agent_id
        or metadata.get("manager_runtime_task_id") != values.manager_runtime_task_id
    ):
        return False
    assignments = metadata.get("dispatch_assignments", [])
    if len(assignments) != len(values.items):
        return False
    for assignment, command in zip(assignments, values.items):
        target_id = assignment.get("assignee_id") or assignment.get("human_user_id")
        if (
            assignment.get("assignment_id") != command.assignment_id
            or assignment.get("task_title") != command.title
            or assignment.get("instructions") != command.instructions
            or assignment.get("assignee_type") != command.assignee_type
            or str(target_id) != command.assignee_id
            or assignment.get("workflow_stage_id") != command.workflow_stage_id
        ):
            return False
    return True


def batch_response(
    values: LoopItemExecutionBatchCreate, assignments: list[dict[str, object]]
) -> dict[str, object]:
    return {
        "dispatch_id": values.dispatch_id,
        "round_id": values.round_id,
        "human_assignments": [
            {**assignment, "status": "queued"}
            for assignment in assignments
            if assignment.get("assignee_type") == "human"
        ],
    }
