# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Personal Agent and execution-environment resource discovery."""

from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.async_utils import run_in_threadpool_with_cleanup
from app.models.kind import Kind
from app.models.share_link import ResourceType
from app.models.user import User
from app.services.workspaces.environment_status import execution_environment_statuses
from app.services.workspaces.resource_mapping import (
    agent_display_name,
    agent_status,
    personal_environment_values,
)
from app.services.workspaces.storage import workspace_ids_for_resources
from shared.telemetry.decorators import trace_async, trace_sync


@dataclass(frozen=True)
class _PersonalResourceCatalog:
    owner: User
    agents: list[dict[str, object]]
    devices: list[Kind]
    device_workspace_ids: dict[int, list[str]]


class WorkspacePersonalResourceService:
    """List user-owned resources and their Workspace availability."""

    @trace_async("workspace.list_personal_resources", tracer_name="backend")
    async def list_personal_resources(
        self, db: Session, user_id: int
    ) -> dict[str, list[dict[str, object]]]:
        catalog = await run_in_threadpool_with_cleanup(
            self._load_personal_resource_catalog, db, user_id
        )
        connection_statuses = await execution_environment_statuses(catalog.devices)
        return {
            "agents": catalog.agents,
            "execution_environments": [
                personal_environment_values(
                    device,
                    connection_status=connection_statuses[device.id],
                    owner=catalog.owner,
                    workspace_ids=catalog.device_workspace_ids.get(device.id, []),
                )
                for device in catalog.devices
            ],
        }

    @trace_sync("workspace.personal_resource_catalog", tracer_name="backend")
    def _load_personal_resource_catalog(
        self, db: Session, user_id: int
    ) -> _PersonalResourceCatalog:
        """Keep database and synchronous readiness checks off the event loop."""
        user = db.get(User, user_id)
        if user is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
        teams = _list_owned_kinds(db, user_id, "Team")
        devices = _list_owned_kinds(db, user_id, "Device")
        team_workspace_ids = workspace_ids_for_resources(
            db,
            resource_type=ResourceType.TEAM.value,
            resource_ids=[team.id for team in teams],
        )
        device_workspace_ids = workspace_ids_for_resources(
            db,
            resource_type=ResourceType.DEVICE.value,
            resource_ids=[device.id for device in devices],
        )
        environment_ids = [str(device.id) for device in devices]
        return _PersonalResourceCatalog(
            owner=user,
            agents=[
                {
                    "id": str(team.id),
                    "name": agent_display_name(team),
                    "team_id": team.id,
                    "owner_type": "user",
                    "owner_id": str(user.id),
                    "owner_name": user.user_name,
                    "status": agent_status(
                        db,
                        team,
                        execution_user_id=user_id,
                    ),
                    "execution_environment_ids": environment_ids,
                    "workspace_ids": team_workspace_ids.get(team.id, []),
                }
                for team in teams
            ],
            devices=devices,
            device_workspace_ids=device_workspace_ids,
        )


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
