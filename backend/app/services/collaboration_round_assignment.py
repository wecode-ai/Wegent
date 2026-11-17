# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project a collaboration round onto the Issue's visible owner."""

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_items.service import loop_item_service
from app.services.stage_assignees import (
    stage_assignee_enforcement_enabled,
    stage_node,
    validate_stage_assignee,
)


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
    project = db.get(CloudProject, item.cloud_project_id)
    if project is None:
        raise ValueError("The Issue project is unavailable")
    metadata = item.metadata_json or {}
    node = stage_node(project, metadata) or {}
    constrained = stage_assignee_enforcement_enabled(project, metadata) and bool(
        node.get("required_assignee_type")
        or node.get("required_assignee_role")
        or node.get("name") in {"需求提出", "质量验收"}
        or (
            node.get("name") == "开发实现"
            and (metadata.get("quality_handoff") or {}).get("required_assignee_role")
        )
    )
    current_stage_id = node.get("id") if constrained else None
    current_assignments = [
        entry
        for entry in assignments
        if current_stage_id and entry.get("workflow_stage_id") == current_stage_id
    ]
    owner_candidates = current_assignments or assignments
    owner = next(
        (entry for entry in owner_candidates if entry["assignee_type"] == "human"),
        owner_candidates[0],
    )
    human = owner["assignee_type"] == "human"
    member_id = str(owner["human_user_id"] if human else owner["agent_id"])
    metadata = validate_stage_assignee(
        db,
        project=project,
        item=item,
        assignee_type="user" if human else "agent",
        assignee_id=member_id,
        actor_user_id=user_id,
    )
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
