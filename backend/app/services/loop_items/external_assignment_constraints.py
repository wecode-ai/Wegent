# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validate provider-owned Issues without creating local assignment state."""

from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.services.stage_assignees import stage_workflow, validate_stage_assignee


def external_assignment_item(
    db: Session,
    *,
    project: CloudProject,
    values: dict[str, Any],
) -> LoopItem:
    """Combine authoritative remote tags with the locked local policy snapshot."""
    existing = (
        db.query(LoopItem)
        .filter(LoopItem.id == str(values["id"]))
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    metadata = deepcopy(existing.metadata_json if existing else {}) or {}
    metadata["tags"] = list(values.get("tags") or [])
    workflow = deepcopy(stage_workflow(project, metadata))
    tagged = [
        node["id"]
        for node in workflow.get("nodes", [])
        if node.get("name") in metadata["tags"]
    ]
    if tagged:
        workflow.pop("current_stage_id", None)
        if len(tagged) == 1:
            workflow["current_stage_id"] = tagged[0]
        metadata["workflow"] = workflow
    return LoopItem(
        id=str(values["id"]),
        cloud_project_id=str(project.id),
        created_by_user_id=int(values["created_by_user_id"]),
        version=int(values["version"]),
        metadata_json=metadata,
    )


def validate_external_assignment(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    assignee_type: str,
    assignee_id: str | None,
    workflow_step: str | None,
    user_id: int,
) -> None:
    """Remote assignment writes cannot atomically advance the local workflow."""
    validate_stage_assignee(
        db,
        project=project,
        item=item,
        assignee_type=assignee_type,
        assignee_id=assignee_id,
        stage_id=workflow_step,
        allow_stage_advance=False,
        actor_user_id=user_id,
    )
    if workflow_step:
        validate_stage_assignee(
            db,
            project=project,
            item=item,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
            allow_stage_advance=False,
            actor_user_id=user_id,
        )
