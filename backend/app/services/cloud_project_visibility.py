# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared, set-based read visibility and effective roles for Cloud Projects."""

from sqlalchemy import BigInteger, String, case, cast, func, literal, select, union_all
from sqlalchemy.orm import Query, Session
from sqlalchemy.sql import Select

from app.models.cloud_project import CloudProject
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import ROLE_HIERARCHY, BaseRole

VALID_CLOUD_PROJECT_MEMBER_ROLES = tuple(role.value for role in BaseRole)
ROLES_BY_PRIORITY = {
    priority: BaseRole(role) for role, priority in ROLE_HIERARCHY.items()
}


def user_memberships(user_id: int, resource_type: str) -> Select:
    """Start permission lookups at the user/entity index."""
    return select(ResourceMember.resource_id, ResourceMember.role).where(
        ResourceMember.resource_type == resource_type,
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(user_id),
        ResourceMember.status == MemberStatus.APPROVED.value,
        ResourceMember.role.in_(VALID_CLOUD_PROJECT_MEMBER_ROLES),
    )


def readable_workspace_ids(user_id: int) -> Select:
    return (
        user_memberships(user_id, ResourceType.WORKSPACE.value)
        .with_only_columns(ResourceMember.resource_id)
        .join(Kind, Kind.id == ResourceMember.resource_id)
        .where(
            Kind.kind == "CollaborationWorkspace",
            Kind.is_active.is_(True),
            ResourceMember.role != BaseRole.RestrictedAnalyst.value,
        )
    )


def workspace_project_ids(workspace_id: int) -> Select:
    """Keep the string project primary key uncast when joining numeric grants."""
    return select(cast(ResourceMember.resource_id, String(64))).where(
        ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
        ResourceMember.entity_type == "workspace",
        ResourceMember.entity_id == str(workspace_id),
        ResourceMember.status == MemberStatus.APPROVED.value,
    )


def _inherited_project_grants(user_id: int) -> Select:
    workspaces = readable_workspace_ids(user_id).subquery()
    return (
        select(
            cast(ResourceMember.resource_id, String(64)).label("project_id"),
            literal(ROLE_HIERARCHY[BaseRole.Reporter.value]).label("priority"),
        )
        .join(
            workspaces,
            # Workspace IDs are integers; CHAR casts inherit connection collation.
            cast(ResourceMember.entity_id, BigInteger) == workspaces.c.resource_id,
        )
        .where(
            ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
            ResourceMember.entity_type == "workspace",
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
    )


def project_access_query(
    db: Session, user_id: int, project_id: int | str | None = None
) -> Query:
    """Resolve roles without per-project IO; spaces grant Reporter, not admin."""
    direct = user_memberships(
        user_id, ResourceType.CLOUD_PROJECT.value
    ).with_only_columns(
        cast(ResourceMember.resource_id, String(64)).label("project_id"),
        case(ROLE_HIERARCHY, value=ResourceMember.role).label("priority"),
    )
    public = select(
        CloudProject.id.label("project_id"),
        literal(ROLE_HIERARCHY[BaseRole.RestrictedAnalyst.value]).label("priority"),
    ).where(
        CloudProject.status == "active",
        CloudProject.metadata_json["visibility"]
        .as_string()
        .in_(("public_restricted", "public")),
    )
    owned = select(
        CloudProject.id.label("project_id"),
        literal(ROLE_HIERARCHY[BaseRole.Owner.value]).label("priority"),
    ).where(CloudProject.created_by_user_id == user_id, CloudProject.status == "active")
    inherited = _inherited_project_grants(user_id)
    if project_id is not None:
        # Push point lookups into every branch before aggregation.
        direct = direct.where(ResourceMember.resource_id == int(project_id))
        inherited = inherited.where(ResourceMember.resource_id == int(project_id))
        public = public.where(CloudProject.id == str(project_id))
        owned = owned.where(CloudProject.id == str(project_id))
    grants = union_all(direct, inherited, public, owned).subquery()
    roles = (
        select(grants.c.project_id, func.min(grants.c.priority).label("priority"))
        .group_by(grants.c.project_id)
        .subquery()
    )
    return (
        db.query(CloudProject, roles.c.priority)
        .join(roles, CloudProject.id == roles.c.project_id)
        .filter(CloudProject.status == "active")
    )


def accessible_cloud_projects(db: Session, user_id: int) -> Query[CloudProject]:
    """Return active projects visible through any valid permission source."""
    return project_access_query(db, user_id).with_entities(CloudProject)
