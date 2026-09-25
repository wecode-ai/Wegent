# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persist one explicit collaboration-manager decision for an Issue."""

from __future__ import annotations

import hashlib
import logging
import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.delivery import LoopItemUpdate
from app.services.collaboration_group_execution import (
    collaboration_group_agent_matches,
    collaboration_group_for_item,
)
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import project_chat_service

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CollaborationManagerDecision:
    item: LoopItem
    comment: ProjectChatMessage | None


def _dispatch_context(execution: LoopItemExecution) -> dict[str, object]:
    intent = execution.execution_intent
    context = intent.get("origin_context") if isinstance(intent, dict) else None
    return dict(context) if isinstance(context, dict) else {}


def _require_manager_dispatch(
    db: Session,
    *,
    project_id: int,
    item: LoopItem,
    user_id: int,
    dispatch_id: str,
    manager_agent_id: str,
) -> ProjectChatAgent:
    group = collaboration_group_for_item(db, item=item, user_id=user_id)
    if group is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Issue is not assigned to a collaboration group",
        )
    manager = db.get(ProjectChatAgent, manager_agent_id)
    if (
        manager is None
        or str(manager.cloud_project_id) != str(project_id)
        or manager.status != "active"
        or not collaboration_group_agent_matches(group.get("leader"), manager)
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Dispatch manager is not the collaboration group leader",
        )
    dispatches = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.cloud_project_id == str(project_id),
        )
        .all()
    )
    if not any(
        execution.executor_type == "collaboration_group_dispatch"
        and str(_dispatch_context(execution).get("dispatch_id") or "") == dispatch_id
        and str(_dispatch_context(execution).get("manager_agent_id") or "")
        == manager.id
        for execution in dispatches
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Collaboration dispatch is unavailable",
        )
    return manager


def _decision_message_key(dispatch_id: str, idempotency_key: str) -> str:
    value = f"manager-decision:{dispatch_id}:{idempotency_key}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def apply_collaboration_manager_decision(
    db: Session,
    *,
    project_id: int,
    item_id: str,
    user_id: int,
    dispatch_id: str,
    manager_agent_id: str,
    idempotency_key: str,
    target_status: str,
    reason: str,
    comment: str = "",
) -> CollaborationManagerDecision:
    """Atomically persist the manager-owned status transition and comment."""

    project = db.get(CloudProject, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    item = (
        db.query(LoopItem)
        .filter(
            LoopItem.id == item_id,
            LoopItem.cloud_project_id == project_id,
        )
        .with_for_update()
        .first()
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
    manager = _require_manager_dispatch(
        db,
        project_id=project_id,
        item=item,
        user_id=user_id,
        dispatch_id=dispatch_id,
        manager_agent_id=manager_agent_id,
    )
    normalized_comment = comment.strip()
    client_message_id = _decision_message_key(dispatch_id, idempotency_key)
    existing_comment = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == str(project_id),
            ProjectChatMessage.task_id == item.id,
            ProjectChatMessage.sender_type == "agent",
            ProjectChatMessage.sender_id == manager.id,
            ProjectChatMessage.client_message_id == client_message_id,
        )
        .first()
    )
    if item.status != target_status:
        item = loop_item_service.update(
            db,
            item.id,
            user_id,
            LoopItemUpdate(version=item.version, status=target_status),
            commit=False,
        )
    message = existing_comment
    if normalized_comment and message is None:
        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        message = ProjectChatMessage(
            message_id=message_id,
            client_message_id=client_message_id,
            project_id=str(project_id),
            task_id=item.id,
            sender_type="agent",
            sender_id=manager.id,
            sender_name=manager.title or manager.name or "AI manager",
            message_type="text",
            content=normalized_comment,
            metadata_json={
                "dispatch_role": "manager",
                "activity_type": "manager_status_comment",
                "dispatch_id": dispatch_id,
                "target_status": target_status,
                "reason": reason,
            },
            agent_id=manager.id,
            status="completed",
        )
        db.add(message)
    db.commit()
    db.refresh(item)
    if message is not None:
        db.refresh(message)
    if message is not None and existing_comment is None:
        push_project_chat_message(
            project_chat_service.to_view(message).model_dump(by_alias=True)
        )
    logger.info(
        "[CollaborationManagerDecision] persisted project_id=%s item_id=%s "
        "dispatch_id=%s target_status=%s comment_requested=%s comment_created=%s "
        "comment_id=%s",
        project_id,
        item.id,
        dispatch_id,
        target_status,
        bool(normalized_comment),
        message is not None and existing_comment is None,
        message.message_id if message is not None else "",
    )
    return CollaborationManagerDecision(item=item, comment=message)
