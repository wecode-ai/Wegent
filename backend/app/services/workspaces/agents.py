# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Workspace Agent authorization management."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.workspace import WorkspaceAgentCreate
from app.services.share import team_share_service
from app.services.workspaces.access import require_workspace_role
from app.services.workspaces.resource_mapping import agent_values
from app.services.workspaces.storage import (
    ensure_resource_grant,
    resource_grant,
)


class WorkspaceAgentService:
    """Authorize Agent Teams for use in a Workspace."""

    def list_agents(
        self, db: Session, workspace_id: int, user_id: int
    ) -> list[dict[str, object]]:
        require_workspace_role(db, workspace_id, user_id)
        rows = (
            db.query(ResourceMember, Kind)
            .join(Kind, Kind.id == ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM.value,
                ResourceMember.entity_type == "workspace",
                ResourceMember.entity_id == str(workspace_id),
                ResourceMember.status == "approved",
                Kind.kind == "Team",
                Kind.is_active.is_(True),
            )
            .order_by(ResourceMember.created_at, ResourceMember.id)
            .all()
        )
        return [agent_values(db, grant=grant, team=team) for grant, team in rows]

    def require_agent_authorized(
        self, db: Session, *, workspace_id: int, team_id: int
    ) -> ResourceMember:
        grant = resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.TEAM.value,
            resource_id=team_id,
        )
        if grant is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Agent is not authorized in this Workspace",
            )
        return grant

    def ensure_accessible_agent_authorized(
        self, db: Session, *, workspace_id: int, user_id: int, team_id: int
    ) -> ResourceMember:
        existing = resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.TEAM.value,
            resource_id=team_id,
        )
        if existing is not None:
            return existing
        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        team = team_share_service.get_resource(db, team_id, user_id)
        if team is None or team.kind != "Team" or not team.is_active:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Agent is not available to this user",
            )
        return ensure_resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.TEAM.value,
            resource_id=int(team.id),
            added_by_user_id=user_id,
            role=BaseRole.Developer,
        )

    def add_agent(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
        values: WorkspaceAgentCreate,
    ) -> dict[str, object]:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        team = team_share_service.get_resource(db, values.team_id, user_id)
        if team is None or team.kind != "Team" or not team.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent Team not found")
        if resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.TEAM.value,
            resource_id=values.team_id,
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Agent is already available in this Workspace",
            )
        grant = ensure_resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=ResourceType.TEAM.value,
            resource_id=int(team.id),
            added_by_user_id=user_id,
            role=BaseRole.Developer,
        )
        db.commit()
        db.refresh(grant)
        return agent_values(db, grant=grant, team=team)

    def remove_agent(
        self, db: Session, workspace_id: int, team_id: int, user_id: int
    ) -> None:
        access = require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        grant, _ = _get_agent_grant(db, workspace_id, team_id)
        if grant.invited_by_user_id != user_id and access.role not in {
            BaseRole.Owner,
            BaseRole.Maintainer,
        }:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
        db.delete(grant)
        db.commit()


def _get_agent_grant(
    db: Session, workspace_id: int, team_id: int
) -> tuple[ResourceMember, Kind]:
    row = (
        db.query(ResourceMember, Kind)
        .join(Kind, Kind.id == ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type == ResourceType.TEAM.value,
            ResourceMember.resource_id == team_id,
            ResourceMember.entity_type == "workspace",
            ResourceMember.entity_id == str(workspace_id),
            ResourceMember.status == "approved",
            Kind.kind == "Team",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace Agent not found")
    return row
