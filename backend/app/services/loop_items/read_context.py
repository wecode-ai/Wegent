# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Request-scoped, set-based inputs for Issue response projection."""

from dataclasses import dataclass

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_is_unset
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_projects.access import CloudProjectAccess
from app.services.collaboration_human_assignments import human_task_bindings
from app.services.loop_items.access import item_security, related_item_filter


@dataclass
class LoopItemReadContext:
    executions: dict[str, LoopItemExecution]
    users: dict[int, User]
    agents: dict[str, ProjectChatAgent]
    teams: dict[int, Kind]
    messages: dict[tuple[str, str], ProjectChatMessage]
    human_bindings: dict[str, dict]
    visible_ids: set[str]

    @classmethod
    def load(
        cls,
        db: Session,
        items: list[LoopItem],
        user_id: int,
        access: CloudProjectAccess,
    ) -> "LoopItemReadContext":
        item_ids = [item.id for item in items]
        executions = _latest_executions(db, item_ids)
        user_ids = {item.assignee_user_id for item in items if item.assignee_user_id}
        agent_ids = {item.assignee_agent_id for item in items if item.assignee_agent_id}
        team_ids = {item.assignee_team_id for item in items if item.assignee_team_id}
        agent_ids.update(row.agent_id for row in executions.values() if row.agent_id)
        team_ids.update(row.team_id for row in executions.values() if row.team_id)
        return cls(
            executions=executions,
            users=(
                {row.id: row for row in db.query(User).filter(User.id.in_(user_ids))}
                if user_ids
                else {}
            ),
            agents=(
                {
                    row.id: row
                    for row in db.query(ProjectChatAgent).filter(
                        ProjectChatAgent.id.in_(agent_ids)
                    )
                }
                if agent_ids
                else {}
            ),
            teams=(
                {row.id: row for row in db.query(Kind).filter(Kind.id.in_(team_ids))}
                if team_ids
                else {}
            ),
            messages=_messages(db, items),
            human_bindings=human_task_bindings(
                db, items, user_id, projects=[access.project]
            ),
            visible_ids=_visible_ids(db, items, user_id, access),
        )


def _latest_executions(
    db: Session, item_ids: list[str]
) -> dict[str, LoopItemExecution]:
    if not item_ids:
        return {}
    latest_ids = (
        db.query(func.max(LoopItemExecution.id))
        .filter(LoopItemExecution.loop_item_id.in_(item_ids))
        .group_by(LoopItemExecution.loop_item_id)
    )
    return {
        row.loop_item_id: row
        for row in db.query(LoopItemExecution).filter(
            LoopItemExecution.id.in_(latest_ids)
        )
    }


def _visible_ids(
    db: Session, items: list[LoopItem], user_id: int, access: CloudProjectAccess
) -> set[str]:
    item_ids = {item.id for item in items}
    if not items or has_permission(access.role, BaseRole.Maintainer):
        return item_ids
    related_ids = {
        item_id
        for (item_id,) in db.query(LoopItem.id).filter(
            LoopItem.id.in_(item_ids), related_item_filter(user_id)
        )
    }
    return {
        item.id
        for item in items
        if item_security(item, access.project) == "open" or item.id in related_ids
    }


def _messages(
    db: Session, items: list[LoopItem]
) -> dict[tuple[str, str], ProjectChatMessage]:
    pairs = set()
    for item in items:
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        state = metadata.get("ai_state")
        message_id = (
            state.get("project_chat_message_id") if isinstance(state, dict) else None
        )
        if isinstance(message_id, str) and message_id:
            pairs.add((item.id, message_id))
    if not pairs:
        return {}
    return {
        (row.task_id, row.message_id): row
        for row in db.query(ProjectChatMessage).filter(
            ProjectChatMessage.task_id.in_({key[0] for key in pairs}),
            ProjectChatMessage.message_id.in_({key[1] for key in pairs}),
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        if (row.task_id, row.message_id) in pairs
    }
