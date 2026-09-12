# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Role-aware authorization for cloud collaboration resources."""

from dataclasses import dataclass
from enum import Enum

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole, has_permission
from app.services.workspaces.storage import workspace_id_for_project


@dataclass(frozen=True)
class CloudProjectAccess:
    project: CloudProject
    role: BaseRole

    @property
    def is_public_visitor(self) -> bool:
        return self.role == BaseRole.RestrictedAnalyst


class IssueAction(str, Enum):
    """Independent Issue capabilities; one action never implies another."""

    EDIT_CONTENT = "edit_content"
    COMMENT = "comment"
    ASSIGN = "assign"
    EXECUTE = "execute"


@dataclass(frozen=True)
class IssuePermissions:
    edit_content: bool
    comment: bool
    assign: bool
    execute: bool

    def allows(self, action: IssueAction) -> bool:
        return bool(getattr(self, action.value))


def issue_permissions(
    access: CloudProjectAccess,
    *,
    issue_creator_user_id: int | None,
    user_id: int,
) -> IssuePermissions:
    """Resolve action-specific permissions without a generic edit shortcut."""

    if access.is_public_visitor:
        owns_issue = issue_creator_user_id == user_id
        return IssuePermissions(
            edit_content=owns_issue,
            comment=owns_issue,
            assign=False,
            execute=owns_issue,
        )
    return IssuePermissions(
        edit_content=has_permission(access.role, BaseRole.Developer),
        comment=has_permission(access.role, BaseRole.Reporter),
        assign=has_permission(access.role, BaseRole.Maintainer),
        execute=has_permission(access.role, BaseRole.Reporter),
    )


def require_issue_action(
    access: CloudProjectAccess,
    *,
    action: IssueAction,
    issue_creator_user_id: int | None,
    user_id: int,
) -> None:
    permissions = issue_permissions(
        access,
        issue_creator_user_id=issue_creator_user_id,
        user_id=user_id,
    )
    if not permissions.allows(action):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")


def require_cloud_project_role(
    db: Session,
    cloud_project_id: int,
    user_id: int,
    required_role: BaseRole = BaseRole.Reporter,
) -> CloudProjectAccess:
    project = (
        db.query(CloudProject)
        .filter(
            CloudProject.id == cloud_project_id,
            CloudProject.status == "active",
        )
        .first()
    )
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")

    if project.created_by_user_id == user_id:
        role = BaseRole.Owner
    else:
        membership = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == cloud_project_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )
        if membership is None:
            if project.visibility != "public":
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "Cloud project not found"
                )
            role = BaseRole.RestrictedAnalyst
        else:
            try:
                role = BaseRole(membership.role)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN, "Invalid cloud project role"
                ) from exc

    workspace_id = workspace_id_for_project(db, project.id)
    if workspace_id is not None and role != BaseRole.RestrictedAnalyst:
        from app.services.workspaces.access import require_workspace_role

        require_workspace_role(db, workspace_id, user_id)

    if not has_permission(role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    return CloudProjectAccess(project=project, role=role)
