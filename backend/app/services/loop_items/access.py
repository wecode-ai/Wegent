# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Issue-level visibility for projects that isolate unrelated work."""

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.cloud_project import LoopItemTaskBinding
from app.models.delivery import (
    LoopItem,
    LoopItemCollaborator,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_projects.access import CloudProjectAccess


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


def related_item_filter(user_id: int) -> ColumnElement[bool]:
    active_task_item_ids = select(LoopItemTaskBinding.loop_item_id).where(
        LoopItemTaskBinding.task_user_id == user_id,
        loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
    )
    collaborator_item_ids = select(LoopItemCollaborator.loop_item_id).where(
        LoopItemCollaborator.user_id == user_id
    )
    owned_agent_ids = select(ProjectChatAgent.id).where(
        ProjectChatAgent.created_by_user_id == user_id,
        ProjectChatAgent.status == "active",
        loop_datetime_is_unset(ProjectChatAgent.deleted_at),
    )
    return or_(
        LoopItem.created_by_user_id == user_id,
        LoopItem.assignee_user_id == user_id,
        LoopItem.id.in_(active_task_item_ids),
        LoopItem.id.in_(collaborator_item_ids),
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
    if has_permission(access.role, BaseRole.Maintainer):
        return True
    return item_security(item, access.project) == "open" or is_related_item(
        db, item.id, user_id
    )
