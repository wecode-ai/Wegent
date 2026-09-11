# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Personal Agent and execution-environment resource discovery."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.models.workspace import (
    WorkspaceAgentBinding,
    WorkspaceExecutionEnvironment,
)
from app.services.workspaces.resource_mapping import (
    agent_status,
    personal_environment_values,
    workspace_ids_by_resource,
)


class WorkspacePersonalResourceService:
    """List user-owned resources and their Workspace availability."""

    def list_personal_resources(
        self,
        db: Session,
        user_id: int,
    ) -> dict[str, list[dict[str, object]]]:
        user = db.get(User, user_id)
        if user is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
        teams = _list_owned_kinds(db, user_id, "Team")
        devices = _list_owned_kinds(db, user_id, "Device")
        team_workspace_ids = workspace_ids_by_resource(
            db,
            WorkspaceAgentBinding,
            WorkspaceAgentBinding.team_id,
            [team.id for team in teams],
        )
        device_workspace_ids = workspace_ids_by_resource(
            db,
            WorkspaceExecutionEnvironment,
            WorkspaceExecutionEnvironment.device_id,
            [device.id for device in devices],
        )
        environments = [
            personal_environment_values(
                device,
                owner=user,
                workspace_ids=device_workspace_ids.get(device.id, []),
            )
            for device in devices
        ]
        environment_ids = [str(device.id) for device in devices]
        return {
            "agents": [
                {
                    "id": str(team.id),
                    "name": team.name,
                    "team_id": team.id,
                    "owner_type": "user",
                    "owner_id": str(user.id),
                    "owner_name": user.user_name,
                    "status": agent_status(team),
                    "execution_environment_ids": environment_ids,
                    "workspace_ids": team_workspace_ids.get(team.id, []),
                }
                for team in teams
            ],
            "execution_environments": environments,
        }


def _list_owned_kinds(db: Session, user_id: int, kind: str) -> list[Kind]:
    return (
        db.query(Kind)
        .filter(
            Kind.kind == kind,
            Kind.user_id == user_id,
            Kind.is_active.is_(True),
        )
        .order_by(Kind.name, Kind.id)
        .all()
    )
