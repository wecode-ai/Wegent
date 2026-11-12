"""Retain exact existing Project resources without granting or remapping them."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.services.collaboration_permissions import collaboration_permission_service


def has_execution_resources(item: LoopItem) -> bool:
    return bool(
        item.assignee_agent_id
        or item.assignee_team_id
        or (item.metadata_json or {}).get("collaboration_group") is not None
    )


def require_original_resource_bindings(
    db: Session, item: LoopItem, source_project_id: str, *, current: bool = False
) -> None:
    """Preserve definition privacy; future actors still need execution authority."""
    policy = collaboration_permission_service
    if item.assignee_agent_id:
        policy.require_project_agent(
            db, source_project_id, item.assignee_agent_id, current=current
        )
    if item.assignee_team_id:
        policy.require_project_team(
            db, source_project_id, item.assignee_team_id, current=current
        )
    reference = (item.metadata_json or {}).get("collaboration_group")
    if reference is not None:
        if not isinstance(reference, dict) or not reference.get("id"):
            raise HTTPException(422, "Original collaboration group is unavailable")
        if (
            str(reference.get("binding_owner_id") or source_project_id)
            != source_project_id
        ):
            raise HTTPException(422, "Original collaboration group source changed")
        policy.require_project_group(
            db, source_project_id, str(reference["id"]), current=current
        )
