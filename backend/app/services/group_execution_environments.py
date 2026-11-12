"""Explicit group Device consent, separate from optional Project resources."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.schemas.base_role import BaseRole
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.collaboration_permissions import RESOURCE_USE_ROLES
from app.services.resource_grant_storage import ensure_resource_member_grant
from app.services.workspaces.environment_status import execution_environment_statuses
from app.services.workspaces.resource_mapping import execution_environment_values
from shared.telemetry.decorators import trace_async


def _grant(
    db: Session, group_id: int | str, device_id: int, *, lock: bool = False
) -> ResourceMember | None:
    query = db.query(ResourceMember).filter_by(
        resource_type="Device",
        resource_id=device_id,
        entity_type="chat_group",
        entity_id=str(group_id),
    )
    if lock:
        query = query.with_for_update().populate_existing()
    return query.first()


@trace_async("group.add_execution_environment", tracer_name="backend")
async def add_group_execution_environment(
    db: Session, group_id: int | str, device_id: int, user_id: int
) -> dict[str, object]:
    require_collaboration_container_access(
        db, group_id, user_id, BaseRole.Maintainer, write=True
    )
    device = (
        db.query(Kind)
        .filter_by(id=device_id, kind="Device", user_id=user_id, is_active=True)
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    if device is None:
        raise HTTPException(404, "Owned execution environment not found")
    existing = _grant(db, group_id, device_id)
    if (
        existing is not None
        and existing.status == "approved"
        and existing.role in RESOURCE_USE_ROLES
    ):
        raise HTTPException(
            409, "Execution environment is already available in this group"
        )
    statuses = await execution_environment_statuses([device])
    grant = ensure_resource_member_grant(
        db,
        resource_type="Device",
        resource_id=device_id,
        entity_type="chat_group",
        entity_id=str(group_id),
        added_by_user_id=user_id,
        role=BaseRole.Developer,
    )
    db.commit()
    db.refresh(grant)
    return execution_environment_values(
        db, grant, device, connection_status=statuses[device.id]
    )


def remove_group_execution_environment(
    db: Session, group_id: int | str, device_id: int, user_id: int
) -> None:
    require_collaboration_container_access(
        db, group_id, user_id, BaseRole.Maintainer, write=True
    )
    grant = _grant(db, group_id, device_id, lock=True)
    if grant is None or grant.status != "approved":
        raise HTTPException(404, "Group execution environment not found")
    db.delete(grant)
    db.flush()
    from app.services.collaboration_revocation import revoke_unauthorized_project_work
    from app.services.loop_item_executions.cancellation import (
        request_execution_cancellations,
    )

    pending = revoke_unauthorized_project_work(db, group_id)
    db.commit()
    request_execution_cancellations(pending)
