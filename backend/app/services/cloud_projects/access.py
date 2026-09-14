# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Role-aware authorization for cloud collaboration resources."""

from dataclasses import asdict, dataclass
from enum import Enum

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_project_visibility import accessible_cloud_projects


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
    CLAIM = "claim"
    HANDOFF = "handoff"
    ASSIGN = "assign"
    EXECUTE = "execute"
    SUBMIT_REVIEW = "submit_review"
    COMPLETE = "complete"
    REOPEN = "reopen"


@dataclass(frozen=True)
class IssuePermissions:
    edit_content: bool
    comment: bool
    claim: bool
    handoff: bool
    assign: bool
    execute: bool
    submit_review: bool
    complete: bool
    reopen: bool

    def allows(self, action: IssueAction) -> bool:
        return bool(getattr(self, action.value))

    def as_dict(self) -> dict[str, bool]:
        return asdict(self)


ISSUE_CONTENT_FIELDS = frozenset(
    {
        "title",
        "description",
        "priority",
        "due_at",
        "parent_id",
        "tags",
        "workflow",
        "execution_config",
    }
)


def required_issue_update_actions(
    *,
    changed_fields: set[str],
    current_assignee_user_id: int | None,
    current_assignee_agent_id: str | None,
    current_assignee_team_id: int | None,
    current_status: str,
    requested_assignee_user_id: int | None,
    requested_assignee_agent_id: str | None,
    requested_assignee_team_id: int | None,
    requested_status: str | None,
    user_id: int,
) -> set[IssueAction]:
    """Map an Issue update to independently authorized actions."""

    actions: set[IssueAction] = set()
    assignee_fields = {
        "assignee_user_id",
        "assignee_agent_id",
        "assignee_team_id",
    }
    assignee_changed = (
        (
            "assignee_user_id" in changed_fields
            and requested_assignee_user_id != current_assignee_user_id
        )
        or (
            "assignee_agent_id" in changed_fields
            and requested_assignee_agent_id != current_assignee_agent_id
        )
        or (
            "assignee_team_id" in changed_fields
            and requested_assignee_team_id != current_assignee_team_id
        )
    )
    if assignee_changed:
        if (
            current_assignee_user_id is None
            and current_assignee_agent_id is None
            and current_assignee_team_id is None
            and requested_assignee_user_id == user_id
            and not {"assignee_agent_id", "assignee_team_id"} & changed_fields
        ):
            actions.add(IssueAction.CLAIM)
        elif current_assignee_user_id == user_id:
            actions.add(IssueAction.HANDOFF)
        else:
            actions.add(IssueAction.ASSIGN)

    if "status" in changed_fields and requested_status != current_status:
        if current_status == "completed":
            actions.add(IssueAction.REOPEN)
        elif requested_status == "completed":
            actions.add(IssueAction.COMPLETE)
        elif requested_status == "in_review":
            actions.add(IssueAction.SUBMIT_REVIEW)
        else:
            actions.add(IssueAction.EDIT_CONTENT)

    if ISSUE_CONTENT_FIELDS & changed_fields:
        actions.add(IssueAction.EDIT_CONTENT)
    return actions


def issue_permissions(
    access: CloudProjectAccess,
    *,
    issue_creator_user_id: int | None,
    assignee_user_id: int | None = None,
    has_assignee: bool | None = None,
    issue_status: str | None = None,
    user_id: int,
) -> IssuePermissions:
    """Resolve action-specific permissions without a generic edit shortcut."""

    if access.is_public_visitor:
        owns_issue = issue_creator_user_id == user_id
        return IssuePermissions(
            edit_content=owns_issue,
            comment=owns_issue,
            claim=False,
            handoff=False,
            assign=False,
            execute=False,
            submit_review=False,
            complete=False,
            reopen=False,
        )
    can_manage = has_permission(access.role, BaseRole.Maintainer)
    can_execute = has_permission(access.role, BaseRole.Developer)
    is_assignee = assignee_user_id == user_id
    assigned = (
        has_assignee if has_assignee is not None else assignee_user_id is not None
    )
    return IssuePermissions(
        edit_content=can_execute,
        comment=has_permission(access.role, BaseRole.Reporter),
        claim=can_execute and not assigned and issue_status != "completed",
        handoff=can_manage or is_assignee,
        assign=can_manage,
        execute=can_execute,
        submit_review=can_manage or is_assignee,
        complete=can_manage,
        reopen=can_manage,
    )


def require_issue_action(
    access: CloudProjectAccess,
    *,
    action: IssueAction,
    issue_creator_user_id: int | None,
    assignee_user_id: int | None = None,
    has_assignee: bool | None = None,
    issue_status: str | None = None,
    user_id: int,
) -> None:
    permissions = issue_permissions(
        access,
        issue_creator_user_id=issue_creator_user_id,
        assignee_user_id=assignee_user_id,
        has_assignee=has_assignee,
        issue_status=issue_status,
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
        accessible_cloud_projects(db, user_id)
        .filter(CloudProject.id == cloud_project_id)
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

    if not has_permission(role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    return CloudProjectAccess(project=project, role=role)
