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

from app.models.delivery import (
    CollaborationChatGroup,
    LoopItem,
    ProjectAutomationRun,
    ProjectChatAgent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.delivery import LoopItemUpdate
from app.services.collaboration_group_execution import (
    collaboration_group_agent_matches,
    collaboration_group_snapshot_for_dispatch,
)
from app.services.loop_item_executions.service import loop_item_execution_service
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
    dispatch_id: str,
    manager_agent_id: str,
) -> tuple[ProjectChatAgent, LoopItemExecution]:
    """Authorize the manager against a current, locked dispatch record."""
    dispatches = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.cloud_project_id == str(project_id),
        )
        .all()
    )
    dispatch = next(
        (
            execution
            for execution in dispatches
            if execution.executor_type == "collaboration_group_dispatch"
            and str(_dispatch_context(execution).get("dispatch_id") or "")
            == dispatch_id
        ),
        None,
    )
    if dispatch is not None:
        # A device scan may have advanced the version since the initial read.
        # Lock only the existing primary-key row, avoiding absent-row gap locks.
        dispatch = (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.id == dispatch.id)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
    if dispatch is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Collaboration dispatch is unavailable",
        )
    # Snapshot reconciliation can advance the execution version independently.
    # Lock and refresh the aggregate before authorizing and completing it, so
    # the Issue decision cannot commit after losing its terminal transition.
    dispatch = (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.id == dispatch.id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    container_is_group = isinstance(
        db.get(CollaborationChatGroup, str(project_id)), CollaborationChatGroup
    )
    if container_is_group or "project_coordination" in dispatch.runtime_origin_context:
        from app.services.collaboration_revocation import execution_authorized

        if not execution_authorized(db, dispatch):
            raise HTTPException(403, "Project coordination authority is revoked")
    group = collaboration_group_snapshot_for_dispatch(item=item, execution=dispatch)
    if container_is_group:
        from app.services.group_collaboration_runtime import runtime_member_agent

        manager = runtime_member_agent(db, item, dispatch, manager_agent_id)
    else:
        manager = db.get(ProjectChatAgent, manager_agent_id)
    if (
        manager is None
        or not container_is_group
        and str(manager.cloud_project_id) != str(project_id)
        or manager.status != "active"
        or str(_dispatch_context(dispatch).get("manager_agent_id") or "") != manager.id
        or not collaboration_group_agent_matches(group.get("leader"), manager)
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Dispatch manager is not the collaboration group leader",
        )
    return manager, dispatch


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
    manager_runtime_task_id: str | None = None,
) -> CollaborationManagerDecision:
    """Atomically persist the manager-owned status transition and comment."""

    from app.services.collaboration_container_access import get_collaboration_container

    project = get_collaboration_container(db, project_id)
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
    manager, dispatch = _require_manager_dispatch(
        db,
        project_id=project_id,
        item=item,
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
        automation_run = (
            db.get(ProjectAutomationRun, dispatch.automation_run_id)
            if dispatch.automation_run_id
            else None
        )
        item = loop_item_service.update(
            db,
            item.id,
            user_id,
            LoopItemUpdate(version=item.version, status=target_status),
            commit=False,
            automation_context=(
                {
                    **dispatch.runtime_origin_context,
                    "run_id": str(automation_run.id),
                }
                if automation_run is not None
                else None
            ),
        )
    if dispatch.status not in {"completed", "failed", "cancelled"}:
        completed = loop_item_execution_service.complete(
            db,
            execution_id=dispatch.id,
            note=reason,
            expected_status=dispatch.status,
            expected_version=dispatch.version,
            commit=False,
            termination_reason="manager_status_decision",
        )
        if completed is None or completed.status != "completed":
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Collaboration dispatch changed during manager decision",
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
        db.flush()
        from app.services.project_chat.runtime_binding import (
            bind_collaboration_manager_activity,
        )

        if manager_runtime_task_id:
            message.metadata_json = {
                **message.metadata_json,
                "manager_runtime_task_id": manager_runtime_task_id,
            }
        bind_collaboration_manager_activity(
            db, dispatch=dispatch, activity=message, item=item
        )
    db.commit()
    db.refresh(item)
    if message is not None:
        db.refresh(message)
    if message is not None and existing_comment is None:
        push_project_chat_message(
            project_chat_service.to_view(message, db=db).model_dump(by_alias=True)
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
