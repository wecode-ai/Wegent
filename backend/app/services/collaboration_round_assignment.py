# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project a collaboration round onto the Issue's visible owner."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
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
