# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Select and lock the activity belonging to one Runtime turn."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import loop_datetime_is_unset
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import ProjectChatCommentExecution
from app.services.project_chat.runtime_binding import collaboration_member_assignment
from app.services.project_chat.runtime_turn import RuntimeTurn


def _matches_turn(db: Session, row: ProjectChatMessage, identity: RuntimeTurn) -> bool:
    metadata = row.metadata_json or {}
    if metadata.get("kind") == "task_ai_subagent" or not identity.matches(
        trigger_id=row.trigger_message_id,
        turn_id=metadata.get("runtime_turn_id"),
        followup=bool(metadata.get("runtime_followup")),
    ):
        return False
    if (
        not identity.trigger_id
        and not metadata.get("runtime_turn_id")
        and metadata.get("dispatch_role") == "member"
    ):
        try:
            collaboration_member_assignment(
                db,
                ProjectChatCommentExecution(
                    project_id=row.project_id,
                    task_id=row.task_id,
                    trigger_message_id=row.message_id,
                ),
                row,
                require_current_assignment=False,
            )
        except HTTPException:
            return False
    return True


def streaming_activity_for_runtime(
    db: Session,
    runtime_device_id: str,
    runtime_task_id: str,
    *,
    device_ids: list[str] | None = None,
    event_payload: dict | None = None,
) -> ProjectChatMessage | None:
    identity = RuntimeTurn.from_event(event_payload or {})
    candidates = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id.in_(device_ids or [runtime_device_id]),
            ProjectChatMessage.runtime_task_id == runtime_task_id,
            ProjectChatMessage.sender_type == "agent",
            ProjectChatMessage.status.in_(["pending", "streaming"]),
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .all()
    )
    matches = [row for row in candidates if _matches_turn(db, row, identity)]
    if len(matches) != 1:
        return None
    # Lock only an existing primary key so absent tasks cannot gap-lock inserts.
    # Refresh the row after waiting for another stream writer to commit.
    row = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.id == matches[0].id,
            ProjectChatMessage.status.in_(["pending", "streaming"]),
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    return row if row is not None and _matches_turn(db, row, identity) else None
