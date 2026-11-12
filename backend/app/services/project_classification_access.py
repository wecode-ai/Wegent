"""Current, locked permission facts for classifying group Threads."""

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session, defer
from sqlalchemy.orm.attributes import set_committed_value

from app.models.delivery import CloudProject, loop_datetime_is_unset
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_project_visibility import (
    VALID_CLOUD_PROJECT_MEMBER_ROLES,
    collaboration_role,
    effective_project_role,
)
from app.services.cloud_projects.access import CloudProjectAccess


def _grants(
    db: Session, kind: str, resource_id: int, user_id: int
) -> list[ResourceMember]:
    return (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == kind,
            ResourceMember.resource_id == resource_id,
            or_(
                (ResourceMember.entity_type == "user")
                & (ResourceMember.entity_id == str(user_id)),
                (ResourceMember.entity_type == "authenticated_users")
                & (ResourceMember.entity_id == "*"),
            ),
        )
        .order_by(ResourceMember.id)
        .with_for_update()
        .populate_existing()
        .all()
    )


def _direct_role(grants: list[ResourceMember]) -> str | None:
    return next(
        (
            collaboration_role(row.role)
            for row in grants
            if row.entity_type == "user"
            and row.status == "approved"
            and row.role in VALID_CLOUD_PROJECT_MEMBER_ROLES
        ),
        None,
    )


def require_locked_workspace(
    db: Session,
    workspace_id: int,
    user_id: int,
    required_role: BaseRole = BaseRole.Maintainer,
) -> Kind:
    """Authorize a resource share from current Workspace and membership facts."""
    actor = (
        db.query(User)
        .filter(User.id == user_id, User.is_active.is_(True))
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    if actor is None:
        raise HTTPException(404, "Workspace not found")
    workspace = (
        db.query(Kind)
        .filter(Kind.id == workspace_id)
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    if (
        workspace is None
        or workspace.kind != "CollaborationWorkspace"
        or not workspace.is_active
    ):
        raise HTTPException(404, "Workspace not found")
    direct = _direct_role(_grants(db, "Workspace", workspace_id, user_id))
    role = (
        BaseRole.Owner
        if workspace.user_id == user_id
        else BaseRole(direct) if direct else None
    )
    if role is None:
        raise HTTPException(404, "Workspace not found")
    if not has_permission(role, required_role):
        raise HTTPException(
            403, "Source administration is required to share this collaboration group"
        )
    return workspace


def require_classification_project(
    db: Session,
    project_id: str,
    user_id: int,
    *,
    required_role: BaseRole = BaseRole.Developer,
) -> CloudProject:
    """Return the project using the existing locked classification authority."""
    return require_classification_project_access(
        db, project_id, user_id, required_role=required_role
    ).project


def require_classification_project_access(
    db: Session,
    project_id: str,
    user_id: int,
    *,
    required_role: BaseRole = BaseRole.Developer,
) -> CloudProjectAccess:
    """Evaluate CP role precedence only from locking reads, including on RR."""
    actor = (
        db.query(User)
        .filter(User.id == user_id, User.is_active.is_(True))
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    if actor is None:
        raise HTTPException(404, "Project not found")
    project = (
        db.query(CloudProject)
        # The scalar workspace projection contains an unlocked subquery. On RR
        # it opens a read view even when this outer SELECT uses FOR UPDATE.
        # Parent authority is read explicitly under locks below instead.
        .options(defer(CloudProject.workspace_id))
        .filter(
            CloudProject.id == project_id,
            CloudProject.status == "active",
            loop_datetime_is_unset(CloudProject.deleted_at),
        )
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    if project is None:
        raise HTTPException(404, "Project not found")
    parents = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "CloudProject",
            ResourceMember.resource_id == int(project_id),
            ResourceMember.entity_type == "workspace",
        )
        .order_by(ResourceMember.id)
        .with_for_update()
        .populate_existing()
        .all()
    )
    parent_ids = {
        row.entity_id
        for row in parents
        if row.status == "approved" and row.entity_id is not None
    }
    if len(parent_ids) != 1:
        raise HTTPException(404, "Project not found")
    parent_id = next(iter(parent_ids))
    if not parent_id.isascii() or not parent_id.isdecimal():
        raise HTTPException(404, "Project not found")
    workspace = (
        db.query(Kind)
        .filter(Kind.id == int(parent_id))
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    if (
        workspace is None
        or workspace.kind != "CollaborationWorkspace"
        or not workspace.is_active
    ):
        raise HTTPException(404, "Project not found")
    direct = _grants(db, "CloudProject", int(project_id), user_id)
    inherited = _direct_role(_grants(db, "Workspace", workspace.id, user_id))
    if workspace.user_id == user_id:
        inherited = "Maintainer"
    elif inherited != "Maintainer" and project.membership_mode not in (None, "inherit"):
        inherited = None
    role = effective_project_role(_direct_role(direct), inherited)
    if role is None and any(
        row.entity_type == "authenticated_users"
        and row.status == "approved"
        and row.role in {"Viewer", "Developer"}
        for row in direct
    ):
        role = "Viewer"
    if role is None:
        raise HTTPException(404, "Project not found")
    if not has_permission(BaseRole(role), required_role):
        message = (
            "Project editing is required to classify a Thread"
            if required_role == BaseRole.Developer
            else "Project management permission is required for migration"
        )
        raise HTTPException(403, message)
    set_committed_value(project, "workspace_id", workspace.id)
    return CloudProjectAccess(project=project, role=BaseRole(role))
