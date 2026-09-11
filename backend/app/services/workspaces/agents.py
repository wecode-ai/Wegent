# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace Agent authorization management."""

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.workspace import WorkspaceAgentBinding
from app.schemas.base_role import BaseRole
from app.schemas.workspace import WorkspaceAgentCreate, WorkspaceAgentUpdate
from app.services.share import team_share_service
from app.services.workspaces.access import require_workspace_role
from app.services.workspaces.resource_mapping import agent_values, internal_owner_type


class WorkspaceAgentService:
    """Authorize Agent Teams for use in a Workspace."""

    def list_agents(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
    ) -> list[dict[str, object]]:
        require_workspace_role(db, workspace_id, user_id)
        rows = (
            db.query(WorkspaceAgentBinding, Kind)
            .join(Kind, Kind.id == WorkspaceAgentBinding.team_id)
            .filter(
                WorkspaceAgentBinding.workspace_id == workspace_id,
                Kind.kind == "Team",
                Kind.is_active.is_(True),
            )
            .order_by(WorkspaceAgentBinding.created_at)
            .all()
        )
        return [agent_values(db, binding=binding, team=team) for binding, team in rows]

    def require_agent_authorized(
        self,
        db: Session,
        *,
        workspace_id: int,
        team_id: int,
    ) -> WorkspaceAgentBinding:
        binding = (
            db.query(WorkspaceAgentBinding)
            .filter(
                WorkspaceAgentBinding.workspace_id == workspace_id,
                WorkspaceAgentBinding.team_id == team_id,
            )
            .first()
        )
        if binding is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Agent is not authorized in this Workspace",
            )
        return binding

    def add_agent(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
        values: WorkspaceAgentCreate,
    ) -> dict[str, object]:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        team = team_share_service.get_resource(db, values.team_id, user_id)
        if team is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent Team not found")
        access = require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        if values.owner_type == "workspace" and access.role not in {
            BaseRole.Owner,
            BaseRole.Maintainer,
        }:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Only Workspace admins can transfer Agent ownership",
            )
        binding = WorkspaceAgentBinding(
            workspace_id=workspace_id,
            team_id=team.id,
            owner_type=internal_owner_type(values.owner_type),
            owner_user_id=None if values.owner_type == "workspace" else team.user_id,
            added_by_user_id=user_id,
        )
        db.add(binding)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Agent is already available in this Workspace"
            ) from exc
        db.refresh(binding)
        return agent_values(db, binding=binding, team=team)

    def update_agent(
        self,
        db: Session,
        workspace_id: int,
        team_id: int,
        user_id: int,
        values: WorkspaceAgentUpdate,
    ) -> dict[str, object]:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Maintainer)
        binding, team = _get_agent_binding(db, workspace_id, team_id)
        binding.owner_type = internal_owner_type(values.owner_type)
        binding.owner_user_id = (
            None if values.owner_type == "workspace" else team.user_id
        )
        db.commit()
        db.refresh(binding)
        return agent_values(db, binding=binding, team=team)

    def remove_agent(
        self,
        db: Session,
        workspace_id: int,
        team_id: int,
        user_id: int,
    ) -> None:
        access = require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        binding, _ = _get_agent_binding(db, workspace_id, team_id)
        if binding.added_by_user_id != user_id and access.role not in {
            BaseRole.Owner,
            BaseRole.Maintainer,
        }:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        db.delete(binding)
        db.commit()


def _get_agent_binding(
    db: Session,
    workspace_id: int,
    team_id: int,
) -> tuple[WorkspaceAgentBinding, Kind]:
    row = (
        db.query(WorkspaceAgentBinding, Kind)
        .join(Kind, Kind.id == WorkspaceAgentBinding.team_id)
        .filter(
            WorkspaceAgentBinding.workspace_id == workspace_id,
            WorkspaceAgentBinding.team_id == team_id,
            Kind.kind == "Team",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace Agent not found")
    return row
