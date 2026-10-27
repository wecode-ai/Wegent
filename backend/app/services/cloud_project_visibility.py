# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Set-based relationship queries shared by collaboration authorization."""

from sqlalchemy import (
    Integer,
    String,
    and_,
    case,
    cast,
    func,
    literal,
    or_,
    select,
    union_all,
)
from sqlalchemy.orm import Query, Session
from sqlalchemy.sql import Select

from app.models.cloud_project import CloudProject
from app.models.delivery import project_parent_relationships
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import COLLABORATION_ROLE_ALIASES, ROLE_HIERARCHY, BaseRole

VALID_CLOUD_PROJECT_MEMBER_ROLES = (
    BaseRole.Owner.value,
    BaseRole.Maintainer.value,
    BaseRole.Developer.value,
    BaseRole.Viewer.value,
    BaseRole.Reporter.value,
)
LEGACY_COLLABORATION_ROLES = COLLABORATION_ROLE_ALIASES


def collaboration_role(role: str) -> str:
    """Interpret retained legacy grants without rewriting shared database rows."""
    return LEGACY_COLLABORATION_ROLES.get(role, role)


def effective_project_role(
    direct_role: str | None, inherited_role: str | None
) -> str | None:
    """Space administration is protected; direct roles override ordinary inheritance."""
    if inherited_role == BaseRole.Maintainer.value:
        return inherited_role
    return direct_role or inherited_role


def collaboration_role_expression():
    return case(
        LEGACY_COLLABORATION_ROLES, value=ResourceMember.role, else_=ResourceMember.role
    )


AUTHENTICATED_ENTITY_TYPE = "authenticated_users"
AUTHENTICATED_ENTITY_ID = "*"
ROLES_BY_PRIORITY = {
    priority: BaseRole(role) for role, priority in ROLE_HIERARCHY.items()
}


def user_memberships(user_id: int, resource_type: str) -> Select:
    return select(
        ResourceMember.resource_id, collaboration_role_expression().label("role")
    ).where(
        ResourceMember.resource_type == resource_type,
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(user_id),
        ResourceMember.status == MemberStatus.APPROVED.value,
        ResourceMember.role.in_(VALID_CLOUD_PROJECT_MEMBER_ROLES),
    )


def readable_workspace_ids(user_id: int) -> Select:
    members = user_memberships(user_id, ResourceType.WORKSPACE.value).subquery()
    return (
        select(Kind.id)
        .outerjoin(members, members.c.resource_id == Kind.id)
        .where(
            Kind.kind == "CollaborationWorkspace",
            Kind.is_active.is_(True),
            or_(Kind.user_id == user_id, members.c.resource_id.is_not(None)),
        )
    )


def workspace_project_ids(workspace_id: int) -> Select:
    return select(CloudProject.id).where(CloudProject.workspace_id == workspace_id)


def _inherited_project_grants(user_id: int) -> Select:
    members = user_memberships(user_id, ResourceType.WORKSPACE.value).subquery()
    parents = project_parent_relationships().subquery()
    is_admin = or_(Kind.user_id == user_id, members.c.role == BaseRole.Maintainer.value)
    return (
        select(
            CloudProject.id.label("project_id"),
            case(
                (is_admin, ROLE_HIERARCHY[BaseRole.Maintainer.value]),
                else_=case(ROLE_HIERARCHY, value=members.c.role),
            ).label("priority"),
        )
        .join(parents, parents.c.project_id == cast(CloudProject.id, Integer))
        .join(Kind, Kind.id == parents.c.workspace_id)
        .outerjoin(members, members.c.resource_id == Kind.id)
        .where(
            Kind.kind == "CollaborationWorkspace",
            Kind.is_active.is_(True),
            or_(is_admin, members.c.resource_id.is_not(None)),
            or_(is_admin, CloudProject.membership_mode == "inherit"),
        )
    )


def project_access_query(
    db: Session, user_id: int, project_id: int | str | None = None
) -> Query:
    """Creators and public visitors are never implicit administrators."""
    direct = user_memberships(
        user_id, ResourceType.CLOUD_PROJECT.value
    ).with_only_columns(
        cast(ResourceMember.resource_id, String(64)).label("project_id"),
        case(ROLE_HIERARCHY, value=collaboration_role_expression()).label("priority"),
    )
    public = select(
        cast(ResourceMember.resource_id, String(64)).label("project_id"),
        literal(ROLE_HIERARCHY[BaseRole.Viewer.value]).label("priority"),
    ).where(
        ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
        ResourceMember.entity_type == AUTHENTICATED_ENTITY_TYPE,
        ResourceMember.entity_id == AUTHENTICATED_ENTITY_ID,
        ResourceMember.status == MemberStatus.APPROVED.value,
        ResourceMember.role.in_((BaseRole.Viewer.value, BaseRole.Developer.value)),
    )
    inherited = _inherited_project_grants(user_id)
    if project_id is not None:
        direct = direct.where(ResourceMember.resource_id == int(project_id))
        inherited = inherited.where(CloudProject.id == str(project_id))
        public = public.where(ResourceMember.resource_id == int(project_id))
    grants = union_all(
        direct.add_columns(literal(1).label("authority")),
        inherited.add_columns(
            case(
                (
                    inherited.selected_columns.priority
                    == ROLE_HIERARCHY[BaseRole.Maintainer.value],
                    0,
                ),
                else_=2,
            ).label("authority")
        ),
        public.add_columns(literal(3).label("authority")),
    ).subquery()
    parents = project_parent_relationships().subquery()
    priority = func.coalesce(
        *(
            func.min(case((grants.c.authority == authority, grants.c.priority)))
            for authority in range(4)
        )
    )
    roles = (
        select(grants.c.project_id, priority.label("priority"))
        .group_by(grants.c.project_id)
        .subquery()
    )
    return (
        db.query(CloudProject, roles.c.priority)
        .join(roles, CloudProject.id == roles.c.project_id)
        .join(parents, parents.c.project_id == cast(CloudProject.id, Integer))
        .join(Kind, Kind.id == parents.c.workspace_id)
        .filter(
            CloudProject.status == "active",
            Kind.kind == "CollaborationWorkspace",
            Kind.is_active.is_(True),
            select(User.id)
            .where(User.id == user_id, User.is_active.is_(True))
            .exists(),
        )
    )


def accessible_cloud_projects(db: Session, user_id: int) -> Query[CloudProject]:
    return project_access_query(db, user_id).with_entities(CloudProject)


def project_membership_rows(
    db: Session, project: CloudProject
) -> tuple[Kind | None, list[ResourceMember]]:
    """Load roster inputs once, including retained direct grant identities."""
    workspace = db.get(Kind, project.workspace_id) if project.workspace_id else None
    grants = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.entity_type == "user",
            or_(
                and_(
                    ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                    ResourceMember.resource_id == int(project.id),
                ),
                and_(
                    ResourceMember.resource_type == ResourceType.WORKSPACE.value,
                    ResourceMember.resource_id == project.workspace_id,
                ),
            ),
        )
        .all()
    )
    return workspace, grants


def project_grant_roles(grants: list[ResourceMember]) -> dict[tuple[str, str], str]:
    return {
        (grant.resource_type, grant.entity_id): collaboration_role(grant.role)
        for grant in grants
        if grant.entity_type == "user"
        and grant.status == MemberStatus.APPROVED.value
        and grant.role in VALID_CLOUD_PROJECT_MEMBER_ROLES
    }


def project_participant_roles(
    project: CloudProject,
    workspace: Kind | None,
    grants: list[ResourceMember],
    *,
    required_role: BaseRole = BaseRole.Viewer,
) -> dict[int, str]:
    """Apply roster policy to loaded relationships, excluding public visitors."""
    if (
        project.status != "active"
        or workspace is None
        or workspace.kind != "CollaborationWorkspace"
        or not workspace.is_active
    ):
        return {}
    granted_roles = project_grant_roles(grants)
    roles = {
        int(entity_id): role
        for (resource_type, entity_id), role in granted_roles.items()
        if resource_type == ResourceType.CLOUD_PROJECT.value and entity_id.isdecimal()
    }
    roles[int(workspace.user_id)] = BaseRole.Maintainer.value
    for (resource_type, entity_id), inherited_role in granted_roles.items():
        if (
            resource_type != ResourceType.WORKSPACE.value
            or not entity_id.isdecimal()
            or int(entity_id) == workspace.user_id
        ):
            continue
        if (
            project.membership_mode == "inherit"
            or inherited_role == BaseRole.Maintainer.value
        ):
            user_id = int(entity_id)
            roles[user_id] = effective_project_role(roles.get(user_id), inherited_role)
    return {
        user_id: role
        for user_id, role in roles.items()
        if ROLE_HIERARCHY[role]
        <= ROLE_HIERARCHY[collaboration_role(required_role.value)]
    }


def project_participant_ids(
    db: Session, project: CloudProject, *, required_role: BaseRole = BaseRole.Viewer
) -> set[int]:
    """Effective humans for rosters and assignments, excluding public visitors."""
    workspace, grants = project_membership_rows(db, project)
    roles = project_participant_roles(
        project, workspace, grants, required_role=required_role
    )
    return {
        user_id
        for (user_id,) in db.query(User.id).filter(
            User.id.in_(roles), User.is_active.is_(True)
        )
    }
