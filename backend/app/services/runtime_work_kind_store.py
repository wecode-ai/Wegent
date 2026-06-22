# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Kind-backed storage for runtime work central mappings."""

from datetime import datetime, timezone
from hashlib import sha256
from typing import Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.runtime_work import DeviceWorkspaceResponse, DeviceWorkspaceUpsert

DEVICE_WORKSPACE_KIND = "DeviceWorkspace"
DEVICE_WORKSPACE_NAMESPACE = "runtime-work"
API_VERSION = "agent.wecode.io/v1"


def device_workspace_kind_name(device_id: str, workspace_path_hash: str) -> str:
    """Build a stable Kind name for one user/device/workspace mapping."""

    key = f"{device_id.strip()}:{workspace_path_hash}"
    return f"device-workspace-{sha256(key.encode('utf-8')).hexdigest()[:32]}"


def upsert_device_workspace_kind(
    *,
    db: Session,
    user_id: int,
    project_id: int,
    payload: DeviceWorkspaceUpsert,
    workspace_path: str,
    workspace_path_hash: str,
) -> DeviceWorkspaceResponse:
    """Create or update a DeviceWorkspace Kind."""

    device_id = payload.device_id.strip()
    name = device_workspace_kind_name(device_id, workspace_path_hash)
    row = _get_device_workspace_kind(
        db=db,
        user_id=user_id,
        device_id=device_id,
        workspace_path_hash=workspace_path_hash,
        active_only=False,
    )
    status = _kind_status(row) if row else {}
    resource = _device_workspace_resource(
        name=name,
        project_id=project_id,
        device_id=device_id,
        workspace_path=workspace_path,
        workspace_path_hash=workspace_path_hash,
        payload=payload,
        status=status,
    )
    if row is None:
        row = Kind(
            user_id=user_id,
            kind=DEVICE_WORKSPACE_KIND,
            name=name,
            namespace=DEVICE_WORKSPACE_NAMESPACE,
            json=resource,
            is_active=True,
        )
        db.add(row)
    else:
        row.json = resource
        row.is_active = True

    db.commit()
    db.refresh(row)
    return device_workspace_response(row)


def list_device_workspace_kinds(
    *,
    db: Session,
    user_id: int,
    project_ids: Optional[list[int]] = None,
) -> list[DeviceWorkspaceResponse]:
    """List active DeviceWorkspace Kinds for one user."""

    rows = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == DEVICE_WORKSPACE_KIND,
            Kind.namespace == DEVICE_WORKSPACE_NAMESPACE,
            Kind.is_active,
        )
        .order_by(Kind.updated_at.desc(), Kind.id.desc())
        .all()
    )
    allowed_project_ids = set(project_ids) if project_ids is not None else None
    mappings: list[DeviceWorkspaceResponse] = []
    for row in rows:
        mapping = device_workspace_response(row)
        if allowed_project_ids is None or mapping.project_id in allowed_project_ids:
            mappings.append(mapping)
    return mappings


def get_device_workspace_kind_by_id(
    *,
    db: Session,
    user_id: int,
    workspace_id: int,
) -> Optional[DeviceWorkspaceResponse]:
    """Load one active DeviceWorkspace Kind by row ID for one user."""

    row = (
        db.query(Kind)
        .filter(
            Kind.id == workspace_id,
            Kind.user_id == user_id,
            Kind.kind == DEVICE_WORKSPACE_KIND,
            Kind.namespace == DEVICE_WORKSPACE_NAMESPACE,
            Kind.is_active,
        )
        .first()
    )
    return device_workspace_response(row) if row is not None else None


def touch_device_workspace_kind(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path_hash: str,
) -> Optional[DeviceWorkspaceResponse]:
    """Update last-seen metadata for an existing DeviceWorkspace Kind."""

    row = _get_device_workspace_kind(
        db=db,
        user_id=user_id,
        device_id=device_id,
        workspace_path_hash=workspace_path_hash,
    )
    if row is None:
        return None

    resource = dict(row.json or {})
    status = _kind_status(row)
    status["lastSeenAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    resource["status"] = status
    row.json = resource
    db.commit()
    db.refresh(row)
    return device_workspace_response(row)


def deactivate_device_workspace_kind(
    *,
    db: Session,
    user_id: int,
    project_id: int,
    device_id: str,
    workspace_path_hash: str,
) -> bool:
    """Deactivate one DeviceWorkspace Kind if it belongs to the given Project."""

    row = _get_device_workspace_kind(
        db=db,
        user_id=user_id,
        device_id=device_id,
        workspace_path_hash=workspace_path_hash,
    )
    if row is None:
        return False

    mapping = device_workspace_response(row)
    if mapping.project_id != project_id:
        return False

    row.is_active = False
    db.commit()
    return True


def device_workspace_response(row: Kind) -> DeviceWorkspaceResponse:
    """Convert a DeviceWorkspace Kind row to the API response shape."""

    spec = _kind_spec(row)
    status = _kind_status(row)
    return DeviceWorkspaceResponse.model_validate(
        {
            "id": row.id,
            "userId": row.user_id,
            "projectId": int(spec["projectId"]),
            "deviceId": str(spec["deviceId"]),
            "workspacePath": str(spec["workspacePath"]),
            "repoUrl": spec.get("repoUrl"),
            "repoRootFingerprint": spec.get("repoRootFingerprint"),
            "label": spec.get("label"),
            "createdAt": row.created_at,
            "updatedAt": row.updated_at,
            "lastSeenAt": status.get("lastSeenAt"),
        }
    )


def _get_device_workspace_kind(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    workspace_path_hash: str,
    active_only: bool = True,
) -> Optional[Kind]:
    name = device_workspace_kind_name(device_id, workspace_path_hash)
    query = db.query(Kind).filter(
        Kind.user_id == user_id,
        Kind.kind == DEVICE_WORKSPACE_KIND,
        Kind.namespace == DEVICE_WORKSPACE_NAMESPACE,
        Kind.name == name,
    )
    if active_only:
        query = query.filter(Kind.is_active)
    return query.first()


def _device_workspace_resource(
    *,
    name: str,
    project_id: int,
    device_id: str,
    workspace_path: str,
    workspace_path_hash: str,
    payload: DeviceWorkspaceUpsert,
    status: dict,
) -> dict:
    return {
        "apiVersion": API_VERSION,
        "kind": DEVICE_WORKSPACE_KIND,
        "metadata": {
            "name": name,
            "namespace": DEVICE_WORKSPACE_NAMESPACE,
        },
        "spec": {
            "projectId": project_id,
            "deviceId": device_id,
            "workspacePath": workspace_path,
            "workspacePathHash": workspace_path_hash,
            "repoUrl": payload.repo_url,
            "repoRootFingerprint": payload.repo_root_fingerprint,
            "label": payload.label,
        },
        "status": status,
    }


def _kind_spec(row: Kind) -> dict:
    payload = row.json if isinstance(row.json, dict) else {}
    spec = payload.get("spec")
    return spec if isinstance(spec, dict) else {}


def _kind_status(row: Kind) -> dict:
    payload = row.json if isinstance(row.json, dict) else {}
    status = payload.get("status")
    return dict(status) if isinstance(status, dict) else {}
