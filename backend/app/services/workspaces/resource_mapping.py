# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Map Kind grants to Workspace API values."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.workspaces.storage import workspace_from_kind


def agent_values(
    db: Session,
    *,
    grant: ResourceMember,
    team: Kind,
    execution_user_id: int,
) -> dict[str, object]:
    owner_type, owner_id, owner_name, owner_user_id = owner_values(
        db, grant=grant, resource=team
    )
    environment_ids = [
        str(row.resource_id)
        for row in _workspace_grants(
            db, int(grant.entity_id), ResourceType.DEVICE.value
        )
    ]
    return {
        "id": team.id,
        "workspace_id": grant.entity_id,
        "team_id": team.id,
        "name": team.name,
        "namespace": team.namespace,
        "owner_type": owner_type,
        "owner_id": owner_id,
        "owner_name": owner_name,
        "status": agent_status(db, team, execution_user_id=execution_user_id),
        "execution_environment_ids": environment_ids,
        "owner_user_id": owner_user_id,
        "added_by_user_id": grant.invited_by_user_id,
        "created_at": grant.created_at,
        "updated_at": grant.updated_at,
    }


def execution_environment_values(
    db: Session,
    grant: ResourceMember,
    device: Kind,
    *,
    connection_status: str,
    workspace_id: str | None = None,
) -> dict[str, object]:
    spec = _kind_spec(device)
    device_type = str(spec.get("deviceType") or "local")
    owner_type, owner_id, owner_name, owner_user_id = owner_values(
        db, grant=grant, resource=device
    )
    capabilities = spec.get("capabilities")
    return {
        "id": device.id,
        "workspace_id": workspace_id or grant.entity_id,
        "device_id": device.id,
        "device_key": str(spec.get("deviceId") or device.name),
        "name": str(spec.get("displayName") or device.name),
        "kind": execution_environment_kind(device_type),
        "device_type": device_type,
        "runtime_instance_id": (
            str(spec["runtimeInstanceId"])
            if isinstance(spec.get("runtimeInstanceId"), str)
            and spec.get("runtimeInstanceId")
            else None
        ),
        "capabilities": (
            [str(value) for value in capabilities]
            if isinstance(capabilities, list)
            else []
        ),
        "coding_tools": coding_tools(spec),
        "owner_type": owner_type,
        "owner_id": owner_id,
        "owner_name": owner_name,
        "status": connection_status,
        "owner_user_id": owner_user_id,
        "added_by_user_id": grant.invited_by_user_id,
        "created_at": grant.created_at,
        "updated_at": device.updated_at,
    }


def personal_environment_values(
    device: Kind,
    *,
    connection_status: str,
    owner: User,
    workspace_ids: list[str],
) -> dict[str, object]:
    spec = _kind_spec(device)
    device_type = str(spec.get("deviceType") or "local")
    return {
        "id": str(device.id),
        "device_id": device.id,
        "device_key": str(spec.get("deviceId") or device.name),
        "name": str(spec.get("displayName") or device.name),
        "kind": execution_environment_kind(device_type),
        "coding_tools": coding_tools(spec),
        "owner_type": "user",
        "owner_id": str(owner.id),
        "owner_name": owner.user_name,
        "status": connection_status,
        "workspace_ids": workspace_ids,
        "updated_at": device.updated_at,
    }


def coding_tools(spec: dict[str, object]) -> list[str]:
    """Return product-facing coding tools implemented by the device Runtime."""
    configured = spec.get("codingTools")
    if isinstance(configured, list):
        return [str(value) for value in configured if str(value).strip()]
    if str(spec.get("bindShell") or "claudecode").lower() == "openclaw":
        return ["openclaw"]
    return ["claude_code", "codex"]


def owner_values(
    db: Session,
    *,
    grant: ResourceMember,
    resource: Kind,
) -> tuple[str, str, str, int | None]:
    if grant.role == BaseRole.Owner.value:
        workspace_kind = db.get(Kind, int(grant.entity_id))
        workspace = (
            workspace_from_kind(workspace_kind) if workspace_kind is not None else None
        )
        return (
            "workspace",
            str(grant.entity_id),
            workspace.name if workspace is not None else "",
            None,
        )
    owner = db.get(User, resource.user_id)
    return (
        "user",
        str(resource.user_id),
        owner.user_name if owner is not None else "",
        int(resource.user_id),
    )


def agent_status(
    db: Session,
    team: Kind,
    *,
    execution_user_id: int,
) -> str:
    """Return whether the Agent can execute for the requesting user."""
    if not team.is_active:
        return "unavailable"

    from app.services.execution.team_readiness import (
        validate_team_execution_readiness,
    )

    try:
        validate_team_execution_readiness(
            db,
            team=team,
            execution_user_id=execution_user_id,
        )
    except ValueError:
        return "unavailable"
    return "available"


def execution_environment_kind(device_type: str) -> str:
    return "cloud_host" if device_type in {"cloud", "remote"} else "local_device"


def _workspace_grants(
    db: Session, workspace_id: int, resource_type: str
) -> list[ResourceMember]:
    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == resource_type,
            ResourceMember.entity_type == "workspace",
            ResourceMember.entity_id == str(workspace_id),
            ResourceMember.status == "approved",
        )
        .order_by(ResourceMember.created_at, ResourceMember.id)
        .all()
    )


def _kind_spec(resource: Kind) -> dict[str, object]:
    if not isinstance(resource.json, dict):
        return {}
    spec = resource.json.get("spec")
    return spec if isinstance(spec, dict) else {}
