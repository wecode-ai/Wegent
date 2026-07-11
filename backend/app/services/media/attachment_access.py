"""Shared attachment visibility checks for media services."""

from typing import Optional

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.stores.tasks import subtask_store, task_access_store


def find_accessible_attachment_context(
    db: Session, *, context_id: int, user_id: int
) -> Optional[SubtaskContext]:
    """Return a ready attachment visible to the user, without leaking its existence."""
    context = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id == context_id,
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            SubtaskContext.status == ContextStatus.READY.value,
        )
        .first()
    )
    if not context:
        return None
    if context.user_id == user_id:
        return context
    if context.subtask_id <= 0:
        return None
    subtask = subtask_store.get_by_id(db, subtask_id=context.subtask_id)
    if subtask and task_access_store.is_member(
        db, task_id=subtask.task_id, user_id=user_id
    ):
        return context
    return None
