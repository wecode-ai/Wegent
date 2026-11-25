# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Issue-level visibility for projects that isolate unrelated work."""

from fastapi import HTTPException, status
from sqlalchemy import Integer, cast, func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.cloud_project import CloudProject, LoopItemTaskBinding
from app.models.delivery import (
    LoopItem,
    LoopItemCollaborator,
    ProjectChatAgent,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
    project_parent_relationships,
)
from app.models.kind import Kind
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    require_cloud_project_role,
)


def default_issue_security(project: object) -> str:
    metadata = getattr(project, "metadata_json", None)
    if (
        isinstance(metadata, dict)
        and metadata.get("default_issue_security") == "related"
    ):
        return "related"
    return "open"


def item_security(item: LoopItem, project: object) -> str:
    metadata = item.metadata_json
    if isinstance(metadata, dict) and metadata.get("security_level") in {
        "open",
        "related",
    }:
        return str(metadata["security_level"])
    return default_issue_security(project)


def visible_item_filter(user_id: int, project: object) -> ColumnElement[bool]:
    security = func.coalesce(
        LoopItem.metadata_json["security_level"].as_string(),
        default_issue_security(project),
    )
    return or_(security == "open", related_item_filter(user_id))


def issue_participation_filter(user_id: int) -> ColumnElement[bool]:
    """Direct Issue access requires creation or a current invitation."""
    collaborator_item_ids = select(LoopItemCollaborator.loop_item_id).where(
        LoopItemCollaborator.user_id == user_id
    )
    return or_(
        LoopItem.created_by_user_id == user_id,
        LoopItem.id.in_(collaborator_item_ids),
    )


def related_item_filter(user_id: int) -> ColumnElement[bool]:
    active_task_item_ids = select(LoopItemTaskBinding.loop_item_id).where(
        LoopItemTaskBinding.task_user_id == user_id,
        loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
    )
    owned_agent_ids = select(ProjectChatAgent.id).where(
        ProjectChatAgent.created_by_user_id == user_id,
        ProjectChatAgent.status == "active",
        loop_datetime_is_unset(ProjectChatAgent.deleted_at),
    )
    return or_(
        issue_participation_filter(user_id),
        LoopItem.assignee_user_id == user_id,
        LoopItem.id.in_(active_task_item_ids),
        LoopItem.assignee_agent_id.in_(owned_agent_ids),
    )


def is_related_item(db: Session, item_id: str, user_id: int) -> bool:
    return (
        db.query(LoopItem.id)
        .filter(
            LoopItem.id == item_id,
            related_item_filter(user_id),
        )
        .first()
        is not None
    )


def can_view_item(
    db: Session,
    access: CloudProjectAccess,
    item: LoopItem,
    user_id: int,
) -> bool:
    invitation = next(
        (
            source
            for source in access.sources
            if source.get("kind") == "issue_invitation"
        ),
        None,
    )
    if invitation is not None:
        return invitation.get("issue_id") == item.id
    if has_permission(access.role, BaseRole.Maintainer):
        return True
    return item_security(item, access.project) == "open" or is_related_item(
        db, item.id, user_id
    )


def require_active_issue_user(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Issue recipient must be an active user",
        )
    return user


def explicitly_invited_item_filter(user_id: int) -> ColumnElement[bool]:
    return or_(
        LoopItem.assignee_user_id == user_id,
        LoopItem.id.in_(
            select(LoopItemCollaborator.loop_item_id).where(
                LoopItemCollaborator.user_id == user_id
            )
        ),
    )


def require_item_access(
    db: Session, item: LoopItem, user_id: int
) -> CloudProjectAccess:
    """Resolve current explicit Issue invitations without granting project access."""
    access = None
    try:
        access = require_cloud_project_role(
            db, item.cloud_project_id, user_id, BaseRole.Viewer
        )
    except HTTPException as cause:
        if cause.status_code != status.HTTP_404_NOT_FOUND:
            raise
    if access is not None and has_permission(access.role, BaseRole.Developer):
        return access
    parents = project_parent_relationships().subquery()
    project = (
        db.query(CloudProject)
        .join(parents, parents.c.project_id == cast(CloudProject.id, Integer))
        .join(Kind, Kind.id == parents.c.workspace_id)
        .filter(
            CloudProject.id == item.cloud_project_id,
            CloudProject.status == "active",
            loop_datetime_is_unset(CloudProject.deleted_at),
            Kind.kind == "CollaborationWorkspace",
            Kind.is_active.is_(True),
            func.coalesce(
                CloudProject.metadata_json["task_provider"].as_string(), "local"
            )
            == "local",
        )
        .first()
    )
    if project is not None:
        invited = (
            db.query(LoopItem.id)
            .filter(
                LoopItem.id == item.id,
                loop_datetime_is_unset(LoopItem.deleted_at),
                explicitly_invited_item_filter(user_id),
            )
            .first()
        )
        if invited is not None:
            require_active_issue_user(db, user_id)
            return CloudProjectAccess(
                project=project,
                role=BaseRole.Developer,
                sources=({"kind": "issue_invitation", "issue_id": item.id},),
            )
    if access is not None:
        return access
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
