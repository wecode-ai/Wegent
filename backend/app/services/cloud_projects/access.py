# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Role-aware authorization for cloud collaboration resources."""

from collections.abc import Set
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
    sources: tuple[dict, ...] = ()

    @property
    def is_viewer(self) -> bool:
        return self.role == BaseRole.Viewer


class IssueAction(str, Enum):
    """Independent Issue capabilities; one action never implies another."""

    EDIT_CONTENT = "edit_content"
    COMMENT = "comment"
    ASSIGN = "assign"
    EXECUTE = "execute"


# LoopItemUpdate fields that change Issue content rather than its assignee.
ISSUE_CONTENT_FIELDS = frozenset(
    {
        "title",
        "description",
        "status",
        "priority",
        "start_at",
        "due_at",
        "parent_id",
        "tags",
        "workflow",
        "execution_config",
    }
)
# LoopItemUpdate fields that select the Issue assignee.
ISSUE_ASSIGNMENT_FIELDS = frozenset(
    {
        "assignee_user_id",
        "assignee_agent_id",
        "assignee_team_id",
        "assignee_group_id",
    }
)


def issue_update_actions(changed_fields: Set[str]) -> list[IssueAction]:
    """List the actions required for an update touching ``changed_fields``.

    Assignment and content changes are authorized independently, so an update
    that mixes both kinds of fields must satisfy every action it implies.
    """

    actions: list[IssueAction] = []
    if changed_fields & ISSUE_ASSIGNMENT_FIELDS:
        actions.append(IssueAction.ASSIGN)
    if changed_fields & ISSUE_CONTENT_FIELDS:
        actions.append(IssueAction.EDIT_CONTENT)
    return actions


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
    """Resolve action-specific permissions without a generic edit shortcut.

    Assignment follows the role hierarchy, but the Issue creator always keeps
    control of their own assignee.
    """

    is_developer = has_permission(access.role, BaseRole.Developer)
    return IssuePermissions(
        edit_content=is_developer,
        comment=is_developer,
        assign=is_developer,
        execute=is_developer,
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
    from app.services.collaboration_permissions import collaboration_permission_service

    decision = collaboration_permission_service.check(
        db, user_id, "read", cloud_project_id
    )
    if decision.role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
    project = db.get(CloudProject, str(cloud_project_id))
    role = decision.role

    if not has_permission(role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    return CloudProjectAccess(project=project, role=role, sources=decision.sources)
