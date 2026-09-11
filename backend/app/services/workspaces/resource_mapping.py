# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Map Agent and execution-environment resources to Workspace API values."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.models.workspace import (
    Workspace,
    WorkspaceAgentBinding,
    WorkspaceExecutionEnvironment,
)


def agent_values(
    db: Session,
    *,
    binding: WorkspaceAgentBinding,
    team: Kind,
) -> dict[str, object]:
    owner_type, owner_id, owner_name = owner_values(
        db,
        workspace_id=binding.workspace_id,
        owner_type=binding.owner_type,
        owner_user_id=binding.owner_user_id,
    )
    environment_ids = (
        db.query(WorkspaceExecutionEnvironment.id)
        .filter(WorkspaceExecutionEnvironment.workspace_id == binding.workspace_id)
        .order_by(WorkspaceExecutionEnvironment.created_at)
        .all()
    )
    return {
        "id": binding.id,
        "workspace_id": binding.workspace_id,
        "team_id": team.id,
        "name": team.name,
        "namespace": team.namespace,
        "owner_type": owner_type,
        "owner_id": owner_id,
        "owner_name": owner_name,
        "status": agent_status(team),
        "execution_environment_ids": [
            str(environment_id) for (environment_id,) in environment_ids
        ],
        "workspace_ids": [str(binding.workspace_id)],
        "owner_user_id": binding.owner_user_id,
        "added_by_user_id": binding.added_by_user_id,
        "created_at": binding.created_at,
        "updated_at": binding.updated_at,
    }


def execution_environment_values(
    db: Session,
    binding: WorkspaceExecutionEnvironment,
    device: Kind,
) -> dict[str, object]:
    spec = _kind_spec(device)
    display_name = spec.get("displayName")
    capabilities = spec.get("capabilities")
    device_type = str(spec.get("deviceType") or "local")
    owner_type, owner_id, owner_name = owner_values(
        db,
        workspace_id=binding.workspace_id,
        owner_type=binding.owner_type,
        owner_user_id=binding.owner_user_id,
    )
    return {
        "id": binding.id,
        "workspace_id": binding.workspace_id,
        "device_id": device.id,
        "device_key": str(spec.get("deviceId") or device.name),
        "name": (
            str(display_name)
            if isinstance(display_name, str) and display_name
            else device.name
        ),
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
        "workspace_ids": [str(binding.workspace_id)],
        "owner_user_id": binding.owner_user_id,
        "added_by_user_id": binding.added_by_user_id,
        "created_at": binding.created_at,
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
        "name": str(spec.get("displayName") or device.name),
        "kind": execution_environment_kind(device_type),
        "owner_type": "user",
        "owner_id": str(owner.id),
        "owner_name": owner.user_name,
        "status": execution_environment_status(device),
        "workspace_ids": workspace_ids,
        "updated_at": device.updated_at,
    }


def workspace_ids_by_resource(
    db: Session,
    model: type,
    resource_column: object,
    resource_ids: list[int],
) -> dict[int, list[str]]:
    if not resource_ids:
        return {}
    rows = (
        db.query(resource_column, model.workspace_id)
        .filter(resource_column.in_(resource_ids))
        .order_by(model.workspace_id)
        .all()
    )
    result: dict[int, list[str]] = {}
    for resource_id, workspace_id in rows:
        result.setdefault(int(resource_id), []).append(str(workspace_id))
    return result


def internal_owner_type(owner_type: str) -> str:
    return "human" if owner_type == "user" else "workspace"


def agent_status(team: Kind) -> str:
    if not team.is_active or not isinstance(team.json, dict):
        return "unavailable"
    status = team.json.get("status")
    status = status if isinstance(status, dict) else {}
    raw_state = status.get("state")
    if isinstance(raw_state, str) and raw_state.lower() == "available":
        return "available"
    raw_status = _kind_spec(team).get("status")
    if isinstance(raw_status, str) and raw_status.lower() in {
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


def owner_values(
    db: Session,
    *,
    workspace_id: int,
    owner_type: str,
    owner_user_id: int | None,
) -> tuple[str, str, str]:
    if owner_type == "workspace":
        workspace = db.get(Workspace, workspace_id)
        return (
            "workspace",
            str(workspace_id),
            workspace.name if workspace is not None else "",
        )
    owner = db.get(User, owner_user_id) if owner_user_id is not None else None
    return (
        "user",
        str(owner_user_id or ""),
        owner.user_name if owner is not None else "",
    )


def _kind_spec(resource: Kind) -> dict[str, object]:
    if not isinstance(resource.json, dict):
        return {}
    spec = resource.json.get("spec")
    return spec if isinstance(spec, dict) else {}
