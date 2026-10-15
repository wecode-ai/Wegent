# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project a collaboration round onto the Issue's visible owner."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items.service import loop_item_service


def assign_round_owner(
    db: Session,
    *,
    item: LoopItem,
    assignments: list[dict[str, object]],
    user_id: int,
) -> None:
    """Prefer the first human, otherwise the first agent, as in local projects.

    The Executor already starts agent work and the batch sends human notices.
    Recording ownership here must not schedule or notify a second time.
    """
    if not assignments:
        return
    owner = next(
        (entry for entry in assignments if entry["assignee_type"] == "human"),
        assignments[0],
    )
    human = owner["assignee_type"] == "human"
    member_id = str(owner["human_user_id"] if human else owner["agent_id"])
    issue_assignment_service.record(
        db,
        project_id=item.cloud_project_id,
        issue_id=item.id,
        member_type="human" if human else "agent",
        member_id=member_id,
        assigned_by_user_id=user_id,
        workflow_step=None,
        notify=False,
        trigger="collaboration_round",
        replace_root_assignments=True,
    )
    metadata = dict(item.metadata_json or {})
    if item.assignee_user_id != (int(member_id) if human else None):
        metadata.pop("human_work", None)
    loop_item_service.record_assignment_change(
        metadata,
        user_id,
        "user" if human else "agent",
        member_id,
        str(owner["human_user_name"] if human else owner["agent_name"]),
    )
    item.assignee_user_id = int(member_id) if human else None
    item.assignee_agent_id = "" if human else member_id
    item.assignee_team_id = None
    item.metadata_json = metadata
    item.updated_by_user_id = user_id
    item.version += 1


def agent_round_is_complete(
    db: Session, row: ProjectChatMessage, owner_agent_id: str | None
) -> bool:
    """Only an agent-owned batch can finish without a human delivery review."""

    assignments = _current_agent_round(db, row)
    return (
        bool(assignments)
        and all(assignment.get("status") == "completed" for assignment in assignments)
        and any(
            assignment.get("agent_id") == owner_agent_id for assignment in assignments
        )
    )


def finish_agent_round(
    db: Session, dispatch: LoopItemExecution, row: ProjectChatMessage
) -> bool:
    """Project the reported batch outcome without starting another manager."""
    from app.services.loop_item_executions.service import (
        TERMINAL_STATUSES,
        loop_item_execution_service,
    )

    if dispatch.status in TERMINAL_STATUSES:
        return False
    assignments = _current_agent_round(db, row)
    if not assignments or any(
        assignment.get("status") not in TERMINAL_STATUSES for assignment in assignments
    ):
        return False
    outcomes = {assignment["status"] for assignment in assignments}
    outcome = (
        "failed"
        if "failed" in outcomes
        else "cancelled" if "cancelled" in outcomes else "completed"
    )
    error = next(
        (
            str(assignment.get("error") or "Member execution failed")
            for assignment in assignments
            if assignment["status"] == "failed"
        ),
        None,
    )
    db.flush()
    loop_item_execution_service._transition_terminal(
        db,
        execution_id=dispatch.id,
        terminal_status=outcome,
        observed_state="succeeded" if outcome == "completed" else outcome,
        note="Agent collaboration round finished",
        content=None,
        error=error,
        termination_reason="agent_round_finished",
        commit=False,
    )
    return True


def _current_agent_round(
    db: Session, row: ProjectChatMessage
) -> list[dict[str, object]]:
    """Return only the current batch when every assignee is an agent."""
    metadata = row.metadata_json or {}
    dispatch_id = metadata.get("dispatch_id")
    round_id = metadata.get("coordination_round_id")
    if not dispatch_id or not round_id:
        return []
    messages = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == row.project_id,
            ProjectChatMessage.task_id == row.task_id,
        )
        .order_by(ProjectChatMessage.created_at.desc(), ProjectChatMessage.id.desc())
        .all()
    )
    for message in messages:
        entry = message.metadata_json or {}
        if entry.get("activity_type") == "manager_assignment":
            if (
                entry.get("dispatch_id") != dispatch_id
                or entry.get("coordination_round_id") != round_id
            ):
                return []
            assignments = entry.get("dispatch_assignments")
            if (
                isinstance(assignments, list)
                and bool(assignments)
                and all(
                    isinstance(assignment, dict)
                    and assignment.get("assignee_type") == "agent"
                    for assignment in assignments
                )
            ):
                return assignments
            return []
    return []
