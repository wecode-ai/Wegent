"""Expose legacy public comments in the canonical Thread discussion stream."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItemComment, loop_datetime_value_is_unset
from app.models.project_chat_message import EPOCH_TIME, ProjectChatMessage
from app.models.user import User


def _legacy_comments(
    db: Session, *, source_id: str, group_id: str, thread_ids: tuple[str, ...]
) -> None:
    """Import recorded public text without publishing reminders or private metadata."""
    comments = (
        db.query(LoopItemComment)
        .filter(
            LoopItemComment.cloud_project_id == source_id,
            LoopItemComment.loop_item_id.in_(thread_ids),
        )
        .order_by(LoopItemComment.created_at, LoopItemComment.id)
        .all()
    )
    for comment in comments:
        if not comment.description.strip():
            continue
        message_id = str(comment.id)
        if db.query(ProjectChatMessage.id).filter_by(message_id=message_id).first():
            raise HTTPException(409, "Legacy discussion identity collision")
        metadata = comment.metadata_json or {}
        user = (
            db.get(User, comment.created_by_user_id)
            if comment.created_by_user_id
            else None
        )
        human = user is not None and metadata.get("event_type") is None
        db.add(
            ProjectChatMessage(
                message_id=message_id,
                project_id=group_id,
                task_id=comment.loop_item_id,
                sender_type="user" if human else "system",
                sender_id=str(user.id) if human else "",
                sender_name=user.user_name if user else "",
                message_type="text",
                content=comment.description,
                metadata_json={"legacy_comment_id": str(comment.id)},
                status="completed",
                created_at=comment.created_at,
                updated_at=comment.updated_at,
                deleted_at=(
                    EPOCH_TIME
                    if loop_datetime_value_is_unset(comment.deleted_at)
                    else comment.deleted_at
                ),
            )
        )


def migrate_thread_history(
    db: Session, *, source_id: str, group_id: str, thread_ids: tuple[str, ...]
) -> None:
    """Allocate target cursors in historical order, preserving business message IDs.

    Numeric row IDs are container-local pagination cursors, never message links.
    Source cursors cannot be used in the destination conversation. A fresh target
    sequence merges old comment records with chat without changing their dates.
    """
    original = (
        db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.project_id == source_id,
            ProjectChatMessage.task_id.in_(thread_ids),
        )
        .order_by(ProjectChatMessage.id)
        .all()
    )
    copies = [
        {
            field.key: getattr(row, field.key)
            for field in ProjectChatMessage.__mapper__.column_attrs
            if field.key != "id"
        }
        for row in original
    ]
    for row in original:
        db.delete(row)
    db.flush()
    for values in copies:
        values["project_id"] = group_id
        db.add(ProjectChatMessage(**values))
    # Keep all new rows pending until both histories can be sorted together.
    with db.no_autoflush:
        _legacy_comments(
            db, source_id=source_id, group_id=group_id, thread_ids=thread_ids
        )
        pending = [row for row in db.new if isinstance(row, ProjectChatMessage)]
        for row in pending:
            db.expunge(row)
        pending.sort(key=lambda row: (row.created_at, row.message_id))
        db.add_all(pending)
    db.flush()
