# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Batch project permissions and minimal parent-space navigation metadata."""

from sqlalchemy import BigInteger, cast
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.cloud_project import CloudProjectResponse
from app.services.cloud_project_visibility import (
    AUTHENTICATED_ENTITY_ID,
    AUTHENTICATED_ENTITY_TYPE,
    ROLES_BY_PRIORITY,
    project_access_query,
    workspace_project_ids,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.workspaces.storage import COLLABORATION_WORKSPACE_KIND


def _parent_contexts(db: Session, project_ids: list[str]) -> dict[str, dict]:
    if not project_ids:
        return {}
    rows = (
        db.query(
            ResourceMember.resource_id,
            Kind.id,
            Kind.name,
            Kind.json["metadata"]["publicId"].as_string(),
        )
        .join(Kind, Kind.id == cast(ResourceMember.entity_id, BigInteger))
        .filter(
            ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
            ResourceMember.resource_id.in_([int(value) for value in project_ids]),
            ResourceMember.entity_type == "workspace",
            ResourceMember.status == MemberStatus.APPROVED.value,
            Kind.kind == COLLABORATION_WORKSPACE_KIND,
            Kind.is_active.is_(True),
        )
        .all()
    )
    return {
        str(project_id): {"id": workspace_id, "name": name, "public_id": public_id}
        for project_id, workspace_id, name, public_id in rows
    }


def _response(
    project: CloudProject,
    role: BaseRole,
    user: User,
    context: dict | None,
    all_user_role: str | None,
) -> CloudProjectResponse:
    return CloudProjectResponse.model_validate(
        {
            **project.__dict__,
            "workspace_id": context["id"] if context else None,
            "workspace_context": context,
            "current_user_id": user.id,
            "current_user_name": user.user_name,
            "access_role": role,
            "visibility": "public" if all_user_role else "private",
            "public_access": {"role": all_user_role} if all_user_role else None,
        }
    )


def _all_user_grant_roles(db: Session, project_ids: list[str]) -> dict[str, str]:
    if not project_ids:
        return {}
    rows = (
        db.query(ResourceMember.resource_id, ResourceMember.role)
        .filter(
            ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
            ResourceMember.resource_id.in_([int(value) for value in project_ids]),
            ResourceMember.entity_type == AUTHENTICATED_ENTITY_TYPE,
            ResourceMember.entity_id == AUTHENTICATED_ENTITY_ID,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )
    return {str(project_id): role for project_id, role in rows}


def list_project_responses(
    db: Session, user: User, workspace_id: int | None = None
) -> list[CloudProjectResponse]:
    """Use two SELECTs regardless of the number of returned projects."""
    query = project_access_query(db, user.id)
    if workspace_id is not None:
        query = query.filter(CloudProject.id.in_(workspace_project_ids(workspace_id)))
    rows = query.order_by(CloudProject.updated_at.desc(), CloudProject.id).all()
    contexts = _parent_contexts(db, [str(project.id) for project, _ in rows])
    all_user_roles = _all_user_grant_roles(db, [str(project.id) for project, _ in rows])
    return [
        _response(
            project,
            ROLES_BY_PRIORITY[priority],
            user,
            contexts.get(str(project.id)),
            all_user_roles.get(str(project.id)),
        )
        for project, priority in rows
    ]


def project_response(
    db: Session, project: CloudProject, current_user: User
) -> CloudProjectResponse:
    access = require_cloud_project_role(
        db, int(project.id), current_user.id, BaseRole.Viewer
    )
    contexts = _parent_contexts(db, [str(project.id)])
    all_user_roles = _all_user_grant_roles(db, [str(project.id)])
    return _response(
        project,
        access.role,
        current_user,
        contexts.get(str(project.id)),
        all_user_roles.get(str(project.id)),
    )
