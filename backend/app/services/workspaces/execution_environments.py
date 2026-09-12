# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace execution-environment authorization management."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.workspace import WorkspaceExecutionEnvironmentCreate
from app.services.workspaces.access import require_workspace_role
from app.services.workspaces.resource_mapping import execution_environment_values
from app.services.workspaces.storage import ensure_resource_grant, resource_grant


class WorkspaceExecutionEnvironmentService:
    """Authorize execution environments for use in a Workspace."""

    def list_execution_environments(
        self, db: Session, workspace_id: int, user_id: int
    ) -> list[dict[str, object]]:
        require_workspace_role(db, workspace_id, user_id)
        rows = (
            db.query(ResourceMember, Kind)
            .join(Kind, Kind.id == ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == ResourceType.DEVICE.value,
                ResourceMember.entity_type == "workspace",
                ResourceMember.entity_id == str(workspace_id),
                ResourceMember.status == "approved",
                Kind.kind == "Device",
                Kind.is_active.is_(True),
            )
            .order_by(ResourceMember.created_at, ResourceMember.id)
            .all()
        )
        return [
            execution_environment_values(db, grant, device) for grant, device in rows
        ]

    def require_execution_environment_authorized(
        self,
        db: Session,
        *,
        workspace_id: int,
        user_id: int,
        execution_device_id: str,
    ) -> ResourceMember:
        device = _owned_execution_device(db, user_id, execution_device_id)
        grant = resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.DEVICE.value,
            resource_id=int(device.id),
        )
        if grant is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Execution environment is not authorized in this Workspace",
            )
        return grant

    def ensure_owned_execution_environment_authorized(
        self,
        db: Session,
        *,
        workspace_id: int,
        user_id: int,
        execution_device_id: str,
    ) -> ResourceMember:
        device = _owned_execution_device(db, user_id, execution_device_id)
        existing = resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.DEVICE.value,
            resource_id=int(device.id),
        )
        if existing is not None:
            return existing
        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        return ensure_resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.DEVICE.value,
            resource_id=int(device.id),
            added_by_user_id=user_id,
            role=BaseRole.Developer,
        )

    def add_execution_environment(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
        values: WorkspaceExecutionEnvironmentCreate,
    ) -> dict[str, object]:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        device = (
            db.query(Kind)
            .filter(
                Kind.id == values.device_id,
                Kind.kind == "Device",
                Kind.user_id == user_id,
                Kind.is_active.is_(True),
            )
            .first()
        )
        if device is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Owned execution environment not found"
            )
        if resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.DEVICE.value,
            resource_id=int(device.id),
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Execution environment is already available in this Workspace",
            )
        grant = ensure_resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.DEVICE.value,
            resource_id=int(device.id),
            added_by_user_id=user_id,
            role=BaseRole.Developer,
        )
        db.commit()
        db.refresh(grant)
        return execution_environment_values(db, grant, device)

    def remove_execution_environment(
        self, db: Session, workspace_id: int, device_id: int, user_id: int
    ) -> None:
        access = require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        grant, _ = _get_execution_environment(db, workspace_id, device_id)
        if grant.invited_by_user_id != user_id and access.role not in {
            BaseRole.Owner,
            BaseRole.Maintainer,
        }:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        db.delete(grant)
        db.commit()


def _get_execution_environment(
    db: Session, workspace_id: int, device_id: int
) -> tuple[ResourceMember, Kind]:
    row = (
        db.query(ResourceMember, Kind)
        .join(Kind, Kind.id == ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type == ResourceType.DEVICE.value,
            ResourceMember.resource_id == device_id,
            ResourceMember.entity_type == "workspace",
            ResourceMember.entity_id == str(workspace_id),
            ResourceMember.status == "approved",
            Kind.kind == "Device",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "Execution environment not found"
        )
    return row


def _owned_execution_device(
    db: Session, user_id: int, execution_device_id: str
) -> Kind:
    device = (
        db.query(Kind)
        .filter(
            Kind.kind == "Device",
            Kind.name == execution_device_id,
            Kind.user_id == user_id,
            Kind.is_active.is_(True),
        )
        .first()
    )
    if device is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Execution environment is not available to this user",
        )
    return device
