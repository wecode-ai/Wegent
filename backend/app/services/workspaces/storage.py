# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistence helpers for collaboration Workspaces and resource grants."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.workspace import ExecutionEnvironmentConfig

COLLABORATION_WORKSPACE_KIND = "CollaborationWorkspace"
WORKSPACE_ENTITY_TYPE = "workspace"


@dataclass(frozen=True)
class CollaborationWorkspace:
    """API-facing view over a CollaborationWorkspace Kind."""

    id: int
    public_id: str
    name: str
    description: str
    namespace: str
    created_by_user_id: int
    owner_user_id: int
    is_default: bool
    execution_environment: dict[str, Any]
    status: str
    version: int
    created_at: datetime
    updated_at: datetime


def workspace_from_kind(kind: Kind) -> CollaborationWorkspace:
    payload = kind.json if isinstance(kind.json, dict) else {}
    metadata = payload.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    spec = payload.get("spec")
    spec = spec if isinstance(spec, dict) else {}
    status_value = payload.get("status")
    status_value = status_value if isinstance(status_value, dict) else {}
    return CollaborationWorkspace(
        id=int(kind.id),
        public_id=str(metadata.get("publicId") or kind.id),
        name=kind.name,
        description=str(spec.get("description") or ""),
        namespace=kind.namespace,
        created_by_user_id=int(metadata.get("createdByUserId") or kind.user_id),
        owner_user_id=int(kind.user_id),
        is_default=bool(spec.get("isDefault")),
        execution_environment=ExecutionEnvironmentConfig.model_validate(
            spec.get("executionEnvironment") or {}
        ).model_dump(),
        status="active" if kind.is_active else "archived",
        version=int(status_value.get("version") or 1),
        created_at=kind.created_at,
        updated_at=kind.updated_at,
    )


def workspace_kind_payload(
    *,
    name: str,
    description: str,
    namespace: str,
    public_id: str,
    is_default: bool,
    execution_environment: dict[str, Any] | None = None,
    version: int = 1,
    created_by_user_id: int | None = None,
) -> dict[str, Any]:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": COLLABORATION_WORKSPACE_KIND,
        "metadata": {
            "name": name,
            "namespace": namespace,
            "publicId": public_id,
            **({"createdByUserId": created_by_user_id} if created_by_user_id else {}),
        },
        "spec": {
            "description": description,
            "isDefault": is_default,
            "executionEnvironment": execution_environment or {},
        },
        "status": {
            "state": "active",
            "version": version,
        },
    }


def get_workspace_kind(
    db: Session, workspace_id: int, *, include_archived: bool = False
) -> Kind | None:
    query = db.query(Kind).filter(
        Kind.id == workspace_id,
        Kind.kind == COLLABORATION_WORKSPACE_KIND,
    )
    if not include_archived:
        query = query.filter(Kind.is_active.is_(True))
    return query.first()


def resource_grant(
    db: Session,
    *,
    workspace_id: int,
    resource_type: str,
    resource_id: int,
) -> ResourceMember | None:
    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == resource_type,
            ResourceMember.resource_id == resource_id,
            ResourceMember.entity_type == WORKSPACE_ENTITY_TYPE,
            ResourceMember.entity_id == str(workspace_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .first()
    )


def ensure_resource_grant(
    db: Session,
    *,
    workspace_id: int,
    resource_type: str,
    resource_id: int,
    added_by_user_id: int,
    role: BaseRole,
) -> ResourceMember:
    identity = {
        "resource_type": resource_type,
        "resource_id": resource_id,
        "entity_type": WORKSPACE_ENTITY_TYPE,
        "entity_id": str(workspace_id),
    }
    updates = {
        "role": role.value,
        "status": MemberStatus.APPROVED.value,
        "invited_by_user_id": added_by_user_id,
        "updated_at": func.now(),
    }
    # Insert before locking: absent-row locking reads can deadlock independent
    # grants through InnoDB gap locks. The unique identity also restores inactive
    # grants atomically without replacing their audit history.
    db.flush()
    if db.get_bind().dialect.name == "mysql":
        statement = mysql_insert(ResourceMember).values(**identity, **updates)
        statement = statement.on_duplicate_key_update(**updates)
    else:
        statement = sqlite_insert(ResourceMember).values(**identity, **updates)
        statement = statement.on_conflict_do_update(
            index_elements=list(identity), set_=updates
        )
    db.execute(statement)
    return (
        db.query(ResourceMember)
        .filter_by(**identity)
        .with_for_update()
        .populate_existing()
        .one()
    )


def workspace_id_for_project(db: Session, project_id: int | str) -> int | None:
    project = db.get(CloudProject, str(project_id))
    return int(project.workspace_id) if project and project.workspace_id else None


def project_ids_for_workspace(db: Session, workspace_id: int) -> list[int]:
    rows = db.query(CloudProject.id).filter(CloudProject.workspace_id == workspace_id)
    return [int(project_id) for (project_id,) in rows]


def active_project_ids_for_workspace(db: Session, workspace_id: int) -> list[int]:
    """Return workspace-bound projects that still block workspace archival."""
    project_ids = project_ids_for_workspace(db, workspace_id)
    if not project_ids:
        return []
    rows = (
        db.query(CloudProject.id)
        .filter(
            CloudProject.id.in_(project_ids),
            CloudProject.status == "active",
        )
        .all()
    )
    return [int(project_id) for (project_id,) in rows]


def workspace_ids_for_resources(
    db: Session,
    *,
    resource_type: str,
    resource_ids: list[int],
) -> dict[int, list[str]]:
    if not resource_ids:
        return {}
    rows = (
        db.query(ResourceMember.resource_id, ResourceMember.entity_id)
        .filter(
            ResourceMember.resource_type == resource_type,
            ResourceMember.resource_id.in_(resource_ids),
            ResourceMember.entity_type == WORKSPACE_ENTITY_TYPE,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .order_by(ResourceMember.entity_id)
        .all()
    )
    result: dict[int, list[str]] = {}
    for resource_id, workspace_id in rows:
        result.setdefault(int(resource_id), []).append(str(workspace_id))
    return result
