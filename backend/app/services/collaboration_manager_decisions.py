# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persist one explicit collaboration-manager decision for an Issue."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass

from fastapi import HTTPException, Request, status
from sqlalchemy import JSON, case, func, type_coerce
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    ProjectChatAgent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.delivery import LoopItemResponse, LoopItemUpdate
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
    response: dict


def _require_manager_dispatch(
    db: Session,
    *,
    project_id: int,
    item: LoopItem,
    dispatch_id: str,
    manager_agent_id: str,
) -> tuple[ProjectChatAgent, LoopItemExecution]:
    """Authorize the manager against a current, locked dispatch record."""
    payload = LoopItemExecution.execution_payload
    intent = type_coerce(case((func.json_valid(payload), payload), else_="{}"), JSON)
    matched = (
        db.query(LoopItemExecution.id)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.cloud_project_id == str(project_id),
            intent["origin_context"]["dispatch_id"].as_string() == dispatch_id,
            intent["runtime_selection"]["executor_kind"].as_string()
            == "collaboration_group_dispatch",
        )
        .order_by(LoopItemExecution.id.desc())
        .limit(1)
        .scalar()
    )
    dispatch = (
        (
            db.query(LoopItemExecution)
            .filter_by(id=matched)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        if matched is not None
        else None
    )
    if dispatch is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Collaboration dispatch is unavailable",
        )
    if (
        "project_coordination" in dispatch.runtime_origin_context
        or dispatch.runtime_origin_context.get("dispatch_protocol_version") == 2
    ):
        from app.services.collaboration_revocation import execution_authorized

        if not execution_authorized(db, dispatch):
            raise HTTPException(403, "Project coordination authority is revoked")
    group = collaboration_group_snapshot_for_dispatch(item=item, execution=dispatch)
    manager = db.get(ProjectChatAgent, manager_agent_id)
    if (
        manager is None
        or str(manager.cloud_project_id) != str(project_id)
        or manager.status != "active"
        or str(dispatch.runtime_origin_context.get("manager_agent_id") or "")
        != manager.id
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
    manager_agent_id: str | None,
    round_id: str | None = None,
    idempotency_key: str,
    target_status: str,
    reason: str,
    comment: str = "",
    manager_runtime_task_id: str | None = None,
    manager_turn_id: str | None = None,
    request: Request | None = None,
    task_id: int | None = None,
    subtask_id: int | None = None,
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
    from app.services.issue_coordination import (
        coordination_activity,
        human_authority,
        require_finished_batch,
        require_open_round,
    )

    turn_scope = None
    manager = dispatch = None
    if manager_agent_id:
        manager, dispatch = _require_manager_dispatch(
            db,
            project_id=project_id,
            item=item,
            dispatch_id=dispatch_id,
            manager_agent_id=manager_agent_id,
        )
        if request is not None:
            task_id = getattr(request.state, "execution_task_id", None)
            subtask_id = getattr(request.state, "execution_subtask_id", None)
            if task_id is not None or dispatch.execution_environment == "wegent":
                from app.services.issue_coordination import require_machine_task_scope

                require_machine_task_scope(
                    task_id,
                    dispatch,
                    getattr(request.state, "device_manager_execution_id", None),
                )
        if dispatch.execution_environment == "wegent":
            from app.services.issue_coordination import managed_turn_scope

            turn_scope = managed_turn_scope(db, dispatch, task_id, subtask_id)
            manager_runtime_task_id = str(subtask_id)
        root = coordination_activity(
            db,
            item,
            dispatch_id,
            dispatch.runtime_origin_context["collaboration_group"],
        )
        sender_type, sender_id, sender_name = (
            "agent",
            manager.id,
            manager.title or manager.name,
        )
        if (
            dispatch.runtime_origin_context.get("dispatch_protocol_version") == 2
            and dispatch.executor_owner_user_id != user_id
        ):
            raise HTTPException(
                403, "Collaboration manager execution is owned by another user"
            )
    else:
        from app.models.user import User

        root, _ = human_authority(db, item, user_id, dispatch_id)
        sender_type, sender_id, sender_name = (
            "user",
            str(user_id),
            db.get(User, user_id).user_name,
        )
    normalized_comment = comment.strip()
    client_message_id = _decision_message_key(dispatch_id, idempotency_key)
    digest = hashlib.sha256(
        json.dumps(
            [
                user_id,
                sender_type,
                sender_id,
                round_id,
                idempotency_key,
                target_status,
                reason,
                normalized_comment,
            ],
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    final = root.metadata_json.get("final_decision")
    if turn_scope is not None:
        from app.services.issue_coordination import require_manager_turn

        require_manager_turn(turn_scope[0], subtask_id, final)
    if final:
        if final["digest"] != digest:
            raise HTTPException(409, "Collaboration dispatch already finished")
        prior = (
            db.get(ProjectChatMessage, final["comment_id"])
            if final["comment_id"]
            else None
        )
        return CollaborationManagerDecision(
            item=item, comment=prior, response=final["response"]
        )
    if (
        manager
        and dispatch.runtime_origin_context.get("dispatch_protocol_version") == 2
    ):
        if (
            turn_scope and root.metadata_json.get("last_manager_turn") == turn_scope[1]
        ) or (
            (turn_scope or not manager_turn_id)
            and manager_runtime_task_id
            and manager_runtime_task_id == root.metadata_json.get("last_manager_run")
        ):
            raise HTTPException(409, "Manager turn already submitted assignments")
        require_finished_batch(db, root, item, None if turn_scope else manager_turn_id)
    if not manager:
        require_open_round(db, root, item, round_id)
    existing_comment = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == str(project_id),
            ProjectChatMessage.task_id == item.id,
            ProjectChatMessage.sender_type == sender_type,
            ProjectChatMessage.sender_id == sender_id,
            ProjectChatMessage.client_message_id == client_message_id,
        )
        .first()
    )
    if item.status != target_status:
        automation_run = (
            db.get(ProjectAutomationRun, dispatch.automation_run_id)
            if dispatch and dispatch.automation_run_id
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
    # The managed Task completes after the model receives the tool result.
    if (
        dispatch
        and dispatch.execution_environment != "wegent"
        and dispatch.status not in {"completed", "failed", "cancelled"}
    ):
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
            sender_type=sender_type,
            sender_id=sender_id,
            sender_name=sender_name,
            message_type="text",
            content=normalized_comment,
            metadata_json={
                "dispatch_role": "manager",
                "activity_type": "manager_status_comment",
                "dispatch_id": dispatch_id,
                "target_status": target_status,
                "reason": reason,
            },
            agent_id=manager.id if manager else "",
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
        if dispatch and dispatch.execution_environment != "wegent":
            bind_collaboration_manager_activity(
                db, dispatch=dispatch, activity=message, item=item
            )
    root.status = "completed"
    db.flush()
    response = {
        "item": LoopItemResponse.model_validate(
            loop_item_service.response_values(db, item, user_id)
        ).model_dump(mode="json"),
        "comment": (
            project_chat_service.to_view(message, db=db).model_dump(
                mode="json", by_alias=True
            )
            if message is not None
            else None
        ),
    }
    root.metadata_json = {
        **root.metadata_json,
        "final_decision": {
            "digest": digest,
            **({"manager_runtime_task_id": str(subtask_id)} if turn_scope else {}),
            "comment_id": message.id if message else None,
            "response": response,
        },
    }
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
    return CollaborationManagerDecision(item=item, comment=message, response=response)
