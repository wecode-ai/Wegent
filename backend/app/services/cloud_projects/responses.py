# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Batch project permissions and minimal parent-space navigation metadata."""

from sqlalchemy import Integer, cast, or_
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import project_parent_relationships
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.cloud_project import CloudProjectResponse
from app.services.cloud_project_visibility import (
    AUTHENTICATED_ENTITY_ID,
    AUTHENTICATED_ENTITY_TYPE,
    ROLES_BY_PRIORITY,
    VALID_CLOUD_PROJECT_MEMBER_ROLES,
    collaboration_role,
    project_access_query,
    workspace_project_ids,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.cloud_projects.admin_receipts import project_response_values
from app.services.workspaces.storage import COLLABORATION_WORKSPACE_KIND


def _parent_contexts(db: Session, project_ids: list[str]) -> dict[str, dict]:
    if not project_ids:
        return {}
    parents = project_parent_relationships().subquery()
    rows = (
        db.query(
            CloudProject.id,
            Kind.id,
            Kind.name,
            Kind.user_id,
            Kind.json["metadata"]["publicId"].as_string(),
        )
        .join(parents, parents.c.project_id == cast(CloudProject.id, Integer))
        .join(Kind, Kind.id == parents.c.workspace_id)
        .filter(
            CloudProject.id.in_(project_ids),
            Kind.kind == COLLABORATION_WORKSPACE_KIND,
            Kind.is_active.is_(True),
        )
        .all()
    )
    return {
        str(pid): {
            "id": wid,
            "name": name,
            "public_id": public_id,
            "owner_user_id": owner_id,
        }
        for pid, wid, name, owner_id, public_id in rows
    }


def _permission_sources(
    db: Session,
    projects: list[CloudProject],
    user: User,
    contexts: dict[str, dict],
    public_roles: dict[str, str],
) -> dict[str, list[dict]]:
    if not projects:
        return {}
    rows = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user.id),
            ResourceMember.status == "approved",
            ResourceMember.role.in_(VALID_CLOUD_PROJECT_MEMBER_ROLES),
            or_(
                (ResourceMember.resource_type == "Workspace")
                & ResourceMember.resource_id.in_({p.workspace_id for p in projects}),
                (ResourceMember.resource_type == "CloudProject")
                & ResourceMember.resource_id.in_({int(p.id) for p in projects}),
            ),
        )
        .all()
    )
    grants = {
        (row.resource_type, row.resource_id): collaboration_role(row.role)
        for row in rows
    }
    result = {}
    for project in projects:
        sources = []
        context = contexts[str(project.id)]
        role = (
            BaseRole.Owner
            if context["owner_user_id"] == user.id
            else grants.get(("Workspace", project.workspace_id))
        )
        if role and (
            project.membership_mode == "inherit"
            or has_permission(role, BaseRole.Maintainer)
        ):
            sources.append(
                {
                    "type": "workspace",
                    "workspace_id": str(project.workspace_id),
                    "role": (
                        BaseRole.Maintainer.value if role == BaseRole.Owner else role
                    ),
                }
            )
        context["workspace_access_role"] = role
        direct = grants.get(("CloudProject", int(project.id)))
        if direct:
            sources.append({"type": "direct", "role": direct})
        result[str(project.id)] = sources or (
            [{"type": "public", "role": "Viewer"}]
            if str(project.id) in public_roles
            else []
        )
    return result


def _response(
    project: CloudProject,
    role: BaseRole | None,
    user: User,
    context: dict | None,
    all_user_role: str | None,
    sources: list[dict],
    admin_config: dict | None = None,
    project_values: dict | None = None,
) -> CloudProjectResponse:
    from app.core.config import settings
    from app.mcp_server.tool_catalog import build_project_admin_catalog

    values = project_values if project_values is not None else project.__dict__
    return CloudProjectResponse.model_validate(
        {
            **values,
            "project_admin_config": admin_config,
            "project_admin_capabilities": (
                build_project_admin_catalog(
                    role,
                    values["version"],
                    admin_config["revision"],
                    settings.WEWORK_PROJECT_ADMIN_TOOLS_V1,
                )
                if admin_config is not None
                else None
            ),
            "workspace_id": context["id"] if context else None,
            "workspace_context": context,
            "current_user_id": user.id,
            "current_user_name": user.user_name,
            "access_role": role,
            "membership_mode": (values.get("metadata_json") or {}).get(
                "membership_mode", "inherit"
            ),
            "permission_sources": sources,
            "workspace_access_role": (
                context.get("workspace_access_role") if context else None
            ),
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
            ResourceMember.role.in_((BaseRole.Viewer.value, BaseRole.Developer.value)),
        )
        .all()
    )
    return {str(project_id): "Viewer" for project_id, role in rows}


def list_project_responses(
    db: Session, user: User, workspace_id: int | None = None
) -> list[CloudProjectResponse]:
    """Batch relationships with constant query count for any project count."""
    query = project_access_query(db, user.id)
    if workspace_id is not None:
        query = query.filter(CloudProject.id.in_(workspace_project_ids(workspace_id)))
    rows = query.order_by(CloudProject.updated_at.desc(), CloudProject.id).all()
    contexts = _parent_contexts(db, [str(project.id) for project, _ in rows])
    all_user_roles = _all_user_grant_roles(db, [str(project.id) for project, _ in rows])
    sources = _permission_sources(
        db, [project for project, _ in rows], user, contexts, all_user_roles
    )
    return [
        _response(
            project,
            ROLES_BY_PRIORITY[priority],
            user,
            contexts.get(str(project.id)),
            all_user_roles.get(str(project.id)),
            sources[str(project.id)],
        )
        for project, priority in rows
    ]


def project_response(
    db: Session, project: CloudProject, current_user: User
) -> CloudProjectResponse:
    access = require_cloud_project_role(
        db, int(project.id), current_user.id, BaseRole.Viewer
    )
    return _project_detail_response(
        db, project, current_user, access.role, list(access.sources)
    )


def project_write_response(
    db: Session, project: CloudProject, current_user: User
) -> CloudProjectResponse:
    """Complete an authorized write even when it removes the actor's own access."""
    from app.services.collaboration_permissions import collaboration_permission_service

    receipt = getattr(project, "_project_admin_result", None)
    if not receipt or receipt["actor"]["userId"] != current_user.id:
        return project_response(db, project, current_user)
    decision = collaboration_permission_service.check(
        db, current_user.id, "read", project.id
    )
    return _project_detail_response(
        db, project, current_user, decision.role, list(decision.sources), write=True
    )


def _project_detail_response(
    db: Session,
    project: CloudProject,
    current_user: User,
    role: BaseRole | None,
    sources: list[dict],
    *,
    write: bool = False,
) -> CloudProjectResponse:
    from app.services.cloud_projects.admin import project_admin_config
    from app.services.collaboration_permissions import collaboration_permission_service

    contexts = _parent_contexts(db, [str(project.id)])
    all_user_roles = _all_user_grant_roles(db, [str(project.id)])
    contexts[str(project.id)]["workspace_access_role"] = (
        collaboration_permission_service.workspace_role(
            db, project.workspace_id, current_user.id
        )
    )
    admin_config = project_admin_config(project, db, current_user.id)
    if write and getattr(project, "_project_admin_response", None) is not None:
        receipt = project._project_admin_result
        admin_config = {
            "projectVersion": receipt["projectVersion"],
            "revision": receipt["revision"],
            "configuration": receipt["after"],
        }
    return _response(
        project,
        role,
        current_user,
        contexts.get(str(project.id)),
        all_user_roles.get(str(project.id)),
        sources,
        admin_config,
        project_response_values(project, write=True) if write else None,
    )
