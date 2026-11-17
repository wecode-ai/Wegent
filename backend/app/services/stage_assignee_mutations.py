# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Preflight Issue mutations before assignments or executions are created."""

from copy import deepcopy
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, LoopItemComment
from app.schemas.base_role import BaseRole
from app.services.cloud_project_visibility import project_participant_ids
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_items.access import can_view_item
from app.services.stage_assignees import (
    require_stage_target,
    stage_assignee_enforcement_enabled,
    stage_requires_assignee,
    stage_workflow,
    validate_stage_assignee,
)
from app.services.wework_notifications import create_notification

ASSIGNEE_FIELDS = (
    ("assignee_team_id", "team"),
    ("assignee_agent_id", "agent"),
    ("assignee_user_id", "user"),
)


def lock_issue(db: Session, item: LoopItem, version: int | None = None) -> None:
    """Refresh under the Issue lock before reading its constraints or version."""
    db.query(LoopItem).filter(
        LoopItem.id == item.id
    ).with_for_update().populate_existing().one()
    if version is not None and item.version != version:
        raise HTTPException(
            409, {"code": "version_conflict", "message": "TODO changed"}
        )


def effective_assignee(
    item: LoopItem, updates: dict[str, Any], metadata: dict[str, Any]
) -> tuple[str, str | None]:
    group = metadata.get("collaboration_group")
    if isinstance(group, dict) and group.get("id"):
        return "group", str(group["id"])
    for field, kind in ASSIGNEE_FIELDS:
        value = updates.get(field, getattr(item, field, None))
        if value:
            return kind, str(value)
    return "user", None


def _constraint_config(metadata: dict[str, Any]) -> dict[str, Any]:
    workflow = metadata.get("workflow")
    if not isinstance(workflow, dict):
        return {}
    return {
        "assignee_roles": workflow.get("assignee_roles", {}),
        "feature_flags": workflow.get("feature_flags", {}),
        "nodes": [
            {
                key: node.get(key)
                for key in (
                    "id",
                    "name",
                    "required_assignee_type",
                    "required_assignee_id",
                    "required_assignee_role",
                )
            }
            for node in workflow.get("nodes", [])
            if isinstance(node, dict)
        ],
    }


def require_workflow_creation_override(
    db: Session,
    *,
    project: CloudProject,
    workflow: dict[str, Any],
    user_id: int,
) -> None:
    """Only maintainers may replace project stage constraints at creation."""
    configured = stage_workflow(project, {})
    constrained = bool(configured.get("assignee_roles")) or any(
        stage_requires_assignee(project, {}, node)
        for node in configured.get("nodes", [])
        if isinstance(node, dict)
    )
    if (
        constrained
        and stage_assignee_enforcement_enabled(project, {})
        and _constraint_config({"workflow": workflow})
        != _constraint_config({"workflow": configured})
    ):
        require_cloud_project_role(db, int(project.id), user_id, BaseRole.Maintainer)


def preflight_issue_update(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    updates: dict[str, Any],
    user_id: int,
    changed_fields: set[str],
) -> None:
    """Validate the effective stage and owner, including direct PATCH writes."""
    metadata = deepcopy(updates.get("metadata_json", item.metadata_json) or {})
    if "workflow" in changed_fields and _constraint_config(
        metadata
    ) != _constraint_config(item.metadata_json or {}):
        require_cloud_project_role(db, int(project.id), user_id, BaseRole.Maintainer)
    target_type, target_id = effective_assignee(item, updates, metadata)
    assignment_changed = bool(
        changed_fields
        & {
            "assignee_user_id",
            "assignee_agent_id",
            "assignee_team_id",
            "assignee_group_id",
        }
    )
    checked = validate_stage_assignee(
        db,
        project=project,
        item=item,
        assignee_type=target_type,
        assignee_id=target_id,
        metadata=metadata,
        allow_stage_advance=assignment_changed,
        actor_user_id=user_id,
    )
    if checked != (item.metadata_json or {}) or "metadata_json" in updates:
        updates["metadata_json"] = checked
    record_stage_transition(
        db, project=project, item=item, metadata=checked, user_id=user_id
    )


def stage_observer_user_ids(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    metadata: dict[str, Any],
    waiting: bool = False,
) -> set[int]:
    """Resolve PMO and repair owners without exposing restricted Issues."""
    targets = stage_workflow(project, metadata).get("assignee_roles", {}).get(
        "pmo", []
    ) or [{"assignee_type": "user", "assignee_id": "zhongwei9"}]
    pmo_user_id = None
    for target in targets:
        if target.get("assignee_type") != "user":
            continue
        try:
            resolved = require_stage_target(db, project=project, target=target)
        except HTTPException:
            continue
        pmo_user_id = int(resolved["assignee_id"])
        break
    recipients = (
        set(project_participant_ids(db, project, required_role=BaseRole.Maintainer))
        if waiting or pmo_user_id is None
        else set()
    )
    if pmo_user_id is not None:
        recipients.add(pmo_user_id)
    visible = set()
    visibility_item = LoopItem(id=item.id, metadata_json=metadata)
    for recipient in recipients:
        access = require_cloud_project_role(db, int(project.id), recipient)
        if can_view_item(db, access, visibility_item, recipient):
            visible.add(recipient)
    return visible


def record_stage_transition(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    metadata: dict[str, Any],
    user_id: int,
) -> None:
    """Keep stage advancement and its PMO notice in the mutation transaction."""
    before = (item.metadata_json or {}).get("stage_assignee_history", [])
    after = metadata.get("stage_assignee_history", [])
    if len(after) <= len(before):
        return
    transition = after[-1]
    db.add(
        LoopItemComment(
            cloud_project_id=str(project.id),
            loop_item_id=item.id,
            description=f"Stage advanced: {transition['from_stage']} → {transition['to_stage']} (assignee changed)",
            status="active",
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            metadata_json={
                "event_type": "stage_assignee_transition",
                "issue_version": item.version,
                **transition,
            },
        )
    )
    for recipient in stage_observer_user_ids(
        db, project=project, item=item, metadata=metadata
    ):
        create_notification(
            db,
            user_id=recipient,
            actor_user_id=user_id,
            title="Issue stage advanced",
            body=f"{item.title}: {transition['to_stage']}",
            project_id=str(project.id),
            item_id=item.id,
            payload={"projectId": str(project.id), "itemId": item.id, **transition},
        )
