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
from app.services.execution_environment_initialization import (
    initialize_execution_environment,
)
from app.services.workspaces.access import require_workspace_role
from app.services.workspaces.environment_status import execution_environment_statuses
from app.services.workspaces.resource_mapping import execution_environment_values
from app.services.workspaces.storage import (
    ensure_resource_grant,
    get_workspace_kind,
    resource_grant,
    workspace_from_kind,
    workspace_kind_payload,
)
from shared.telemetry.decorators import trace_async


class WorkspaceExecutionEnvironmentService:
    """Authorize execution environments for use in a Workspace."""

    @trace_async("workspace.list_execution_environments", tracer_name="backend")
    async def list_execution_environments(
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
        connection_statuses = await execution_environment_statuses(
            [device for _, device in rows]
        )
        return [
            execution_environment_values(
                db, grant, device, connection_status=connection_statuses[device.id]
            )
            for grant, device in rows
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

    @trace_async("workspace.add_execution_environment", tracer_name="backend")
    async def add_execution_environment(
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
        connection_statuses = await execution_environment_statuses([device])
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
        return execution_environment_values(
            db, grant, device, connection_status=connection_statuses[device.id]
        )

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

    async def initialize_execution_environment(
        self,
        db: Session,
        workspace_id: int,
        device_id: int,
        user_id: int,
        version: int,
    ):
        require_workspace_role(db, workspace_id, user_id, BaseRole.Maintainer)
        kind = get_workspace_kind(db, workspace_id)
        if kind is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
        current = workspace_from_kind(kind)
        if current.version != version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Workspace changed")
        grant, device = _get_execution_environment(db, workspace_id, device_id)
        if grant is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Execution device is not available in this Workspace",
            )
        state = await initialize_execution_environment(
            db=db,
            device=device,
            environment_id=f"workspace-{workspace_id}",
            definition=current.execution_environment,
        )
        kind.json = workspace_kind_payload(
            name=current.name,
            description=current.description,
            namespace=current.namespace,
            public_id=current.public_id,
            is_default=current.is_default,
            execution_environment=state,
            version=current.version + 1,
        )
        db.commit()
        db.refresh(kind)
        return workspace_from_kind(kind)


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
