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
        "status": agent_status(team),
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
) -> dict[str, object]:
    spec = _kind_spec(device)
    device_type = str(spec.get("deviceType") or "local")
    owner_type, owner_id, owner_name, owner_user_id = owner_values(
        db, grant=grant, resource=device
    )
    capabilities = spec.get("capabilities")
    return {
        "id": device.id,
        "workspace_id": grant.entity_id,
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
        "owner_type": owner_type,
        "owner_id": owner_id,
        "owner_name": owner_name,
        "status": execution_environment_status(device),
        "owner_user_id": owner_user_id,
        "added_by_user_id": grant.invited_by_user_id,
        "created_at": grant.created_at,
        "updated_at": device.updated_at,
    }


def personal_environment_values(
    device: Kind,
    *,
    owner: User,
    workspace_ids: list[str],
) -> dict[str, object]:
    spec = _kind_spec(device)
    device_type = str(spec.get("deviceType") or "local")
    return {
        "id": str(device.id),
        "device_id": device.id,
        "name": str(spec.get("displayName") or device.name),
        "kind": execution_environment_kind(device_type),
        "owner_type": "user",
        "owner_id": str(owner.id),
        "owner_name": owner.user_name,
        "status": execution_environment_status(device),
        "workspace_ids": workspace_ids,
        "updated_at": device.updated_at,
    }


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


def agent_status(team: Kind) -> str:
    if not team.is_active or not isinstance(team.json, dict):
        return "unavailable"
    status = team.json.get("status")
    status = status if isinstance(status, dict) else {}
    if str(status.get("state") or "").lower() == "available":
        return "available"
    if str(_kind_spec(team).get("status") or "").lower() in {
        "available",
        "active",
        "ready",
    }:
        return "available"
    return "unavailable"


def execution_environment_status(device: Kind) -> str:
    if not device.is_active or not isinstance(device.json, dict):
        return "offline"
    raw_status = _kind_spec(device).get("status")
    if not isinstance(raw_status, str):
        status = device.json.get("status")
        status = status if isinstance(status, dict) else {}
        raw_status = status.get("status") or status.get("state")
    normalized = str(raw_status or "").lower()
    if normalized in {"online", "busy", "available", "ready"}:
        return "online"
    if normalized in {"provisioning", "pending", "creating", "starting"}:
        return "provisioning"
    if normalized in {"error", "failed", "unavailable"}:
        return "error"
    return "offline"


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
