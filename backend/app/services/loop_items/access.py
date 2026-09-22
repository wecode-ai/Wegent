# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Issue-level visibility for projects that isolate unrelated work."""

from sqlalchemy import or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.cloud_project import LoopItemTaskBinding
from app.models.delivery import (
    LoopItem,
    LoopItemCollaborator,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.services.cloud_projects.access import CloudProjectAccess


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
    if access.restricts_unrelated_issues:
        return is_related_item(db, item.id, user_id)
    return not access.is_public_visitor or item.created_by_user_id == user_id
