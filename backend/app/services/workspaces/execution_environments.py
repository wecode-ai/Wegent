# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace execution-environment authorization management."""

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.workspace import Workspace, WorkspaceExecutionEnvironment
from app.schemas.base_role import BaseRole
from app.schemas.workspace import WorkspaceExecutionEnvironmentCreate
from app.services.workspaces.access import require_workspace_role
from app.services.workspaces.resource_mapping import (
    execution_environment_values,
    internal_owner_type,
)


class WorkspaceExecutionEnvironmentService:
    """Authorize execution environments for use in a Workspace."""

    def list_execution_environments(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
    ) -> list[dict[str, object]]:
        require_workspace_role(db, workspace_id, user_id)
        rows = (
            db.query(WorkspaceExecutionEnvironment, Kind)
            .join(Kind, Kind.id == WorkspaceExecutionEnvironment.device_id)
            .filter(
                WorkspaceExecutionEnvironment.workspace_id == workspace_id,
                Kind.kind == "Device",
                Kind.is_active.is_(True),
            )
            .order_by(WorkspaceExecutionEnvironment.created_at)
            .all()
        )
        return [
            execution_environment_values(db, binding, device)
            for binding, device in rows
        ]

    def require_execution_environment_authorized(
        self,
        db: Session,
        *,
        workspace_id: int,
        user_id: int,
        execution_device_id: str,
    ) -> WorkspaceExecutionEnvironment:
        device = _owned_execution_device(db, user_id, execution_device_id)
        row = _authorized_execution_environment(
            db,
            workspace_id=workspace_id,
            device_id=device.id,
        )
        if row is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Execution environment is not authorized in this Workspace",
            )
        return row

    def ensure_owned_execution_environment_authorized(
        self,
        db: Session,
        *,
        workspace_id: int,
        user_id: int,
        execution_device_id: str,
    ) -> WorkspaceExecutionEnvironment:
        """Authorize a selected personal environment for the current Workspace."""
        device = _owned_execution_device(db, user_id, execution_device_id)
        existing = _authorized_execution_environment(
            db,
            workspace_id=workspace_id,
            device_id=device.id,
        )
        if existing is not None:
            return existing

        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        db.query(Workspace.id).filter(
            Workspace.id == workspace_id
        ).with_for_update().one()
        existing = _authorized_execution_environment(
            db,
            workspace_id=workspace_id,
            device_id=device.id,
        )
        if existing is not None:
            return existing

        binding = WorkspaceExecutionEnvironment(
            workspace_id=workspace_id,
            device_id=device.id,
            owner_type="human",
            owner_user_id=user_id,
            added_by_user_id=user_id,
        )
        db.add(binding)
        db.flush()
        return binding

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
        binding = WorkspaceExecutionEnvironment(
            workspace_id=workspace_id,
            device_id=device.id,
            owner_type=internal_owner_type(values.owner_type),
            owner_user_id=(
                None if values.owner_type == "workspace" else device.user_id
            ),
            added_by_user_id=user_id,
        )
        if values.owner_type == "workspace":
            require_workspace_role(db, workspace_id, user_id, BaseRole.Maintainer)
        db.add(binding)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Execution environment is already available in this Workspace",
            ) from exc
        db.refresh(binding)
        return execution_environment_values(db, binding, device)

    def remove_execution_environment(
        self,
        db: Session,
        workspace_id: int,
        device_id: int,
        user_id: int,
    ) -> None:
        access = require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        binding, _ = _get_execution_environment(db, workspace_id, device_id)
        if binding.added_by_user_id != user_id and access.role not in {
            BaseRole.Owner,
            BaseRole.Maintainer,
        }:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        db.delete(binding)
        db.commit()


def _get_execution_environment(
    db: Session,
    workspace_id: int,
    device_id: int,
) -> tuple[WorkspaceExecutionEnvironment, Kind]:
    row = (
        db.query(WorkspaceExecutionEnvironment, Kind)
        .join(Kind, Kind.id == WorkspaceExecutionEnvironment.device_id)
        .filter(
            WorkspaceExecutionEnvironment.workspace_id == workspace_id,
            WorkspaceExecutionEnvironment.device_id == device_id,
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


def _authorized_execution_environment(
    db: Session,
    *,
    workspace_id: int,
    device_id: int,
) -> WorkspaceExecutionEnvironment | None:
    return (
        db.query(WorkspaceExecutionEnvironment)
        .filter(
            WorkspaceExecutionEnvironment.workspace_id == workspace_id,
            WorkspaceExecutionEnvironment.device_id == device_id,
        )
        .first()
    )


def _owned_execution_device(
    db: Session,
    user_id: int,
    execution_device_id: str,
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
