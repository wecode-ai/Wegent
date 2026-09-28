# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Role-aware authorization for cloud collaboration resources."""

from dataclasses import dataclass
from enum import Enum

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_project_visibility import (
    ROLES_BY_PRIORITY,
    project_access_query,
)


@dataclass(frozen=True)
class CloudProjectAccess:
    project: CloudProject
    role: BaseRole

    @property
    def is_viewer(self) -> bool:
        return self.role == BaseRole.Viewer


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

    return IssuePermissions(
        edit_content=has_permission(access.role, BaseRole.Developer),
        comment=has_permission(access.role, BaseRole.Developer),
        assign=has_permission(access.role, BaseRole.Maintainer),
        execute=has_permission(access.role, BaseRole.Developer),
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
    required_role: BaseRole = BaseRole.Viewer,
) -> CloudProjectAccess:
    result = project_access_query(db, user_id, cloud_project_id).first()
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
    project, priority = result
    role = ROLES_BY_PRIORITY[priority]

    if not has_permission(role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    return CloudProjectAccess(project=project, role=role)
