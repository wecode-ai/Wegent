# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve failed collaboration dispatches from the latest manager activity."""

from collections.abc import Iterator
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.delivery import loop_datetime_is_unset, loop_datetime_value_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.services.loop_items.locking import lock_existing_issue
from app.services.project_chat.runtime_binding import collaboration_manager_task_id


def expired_manager_failures(
    db: Session, *, before: datetime
) -> Iterator[tuple[LoopItemExecution, ProjectChatMessage]]:
    manager = ProjectChatMessage.metadata_json["dispatch_role"].as_string() == "manager"
    candidate_ids = (
        db.query(LoopItemExecution.id, LoopItemExecution.loop_item_id)
        .filter(
            LoopItemExecution.status.in_(("claimed", "running")),
            LoopItemExecution.lease_expires_at < before,
            ~loop_datetime_is_unset(LoopItemExecution.lease_expires_at),
            db.query(ProjectChatMessage.id)
            .filter(
                ProjectChatMessage.task_id == LoopItemExecution.loop_item_id,
                ProjectChatMessage.project_id == LoopItemExecution.cloud_project_id,
                ProjectChatMessage.status == "failed",
                manager,
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .exists(),
        )
        .all()
    )
    for execution_id, issue_id in candidate_ids:
        lock_existing_issue(db, issue_id)
        execution = (
            db.query(LoopItemExecution)
            .filter_by(id=execution_id)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        failure = _latest_manager_failure(db, execution, before) if execution else None
        if execution is not None and failure is not None:
            yield execution, failure
        else:
            db.rollback()


def _latest_manager_failure(
    db: Session, execution: LoopItemExecution, before: datetime
) -> ProjectChatMessage | None:
    context = execution.runtime_origin_context
    dispatch_id = context.get("dispatch_id")
    if (
        execution.executor_type != "collaboration_group_dispatch"
        or execution.status not in {"claimed", "running"}
        or loop_datetime_value_is_unset(execution.lease_expires_at)
        or execution.lease_expires_at >= before
        or not dispatch_id
        or not execution.runtime_device_id
    ):
        return None
    metadata = ProjectChatMessage.metadata_json
    activity_type = metadata["activity_type"].as_string()
    activity = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == execution.cloud_project_id,
            ProjectChatMessage.task_id == execution.loop_item_id,
            ProjectChatMessage.sender_type == "agent",
            metadata["dispatch_role"].as_string() == "manager",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            or_(
                and_(
                    metadata["dispatch_id"].as_string() == dispatch_id,
                    activity_type.in_(("manager_execution", "manager_assignment")),
                ),
                metadata["execution_id"].as_integer() == execution.id,
            ),
        )
        .order_by(ProjectChatMessage.id.desc())
        .populate_existing()
        .with_for_update()
        .first()
    )
    if (
        activity is None
        or activity.status != "failed"
        or activity.agent_id != context.get("manager_agent_id")
        or activity.runtime_device_id != execution.runtime_device_id
        or not activity.runtime_task_id
    ):
        return None
    try:
        task_id = collaboration_manager_task_id(db, execution, activity)
    except HTTPException:
        return None
    if task_id != activity.runtime_task_id:
        return None
    # An explicit continuation can reuse the same manager conversation. Its
    # execution owns the newer attempt even if the original card is still failed.
    continuation = (
        db.query(LoopItemExecution.id)
        .filter(
            LoopItemExecution.id > execution.id,
            LoopItemExecution.cloud_project_id == execution.cloud_project_id,
            LoopItemExecution.loop_item_id == execution.loop_item_id,
            LoopItemExecution.runtime_task_id == task_id,
        )
        .with_for_update()
        .first()
    )
    return activity if continuation is None else None
