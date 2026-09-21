"""Describe where a notification about one board item should point."""

import re

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.user import User
from app.services.loop_item_status_history import project_board_statuses
from app.services.notification_copy import NotificationTarget


def board_notification_target(
    db: Session, project: CloudProject, item: LoopItem | None
) -> NotificationTarget:
    """Collect the board fields a recipient needs to recognise the item."""

    if item is None:
        return NotificationTarget(project_id=str(project.id), project_name=project.name)
    return NotificationTarget(
        project_id=str(project.id),
        project_name=project.name,
        item_id=item.id,
        item_key=item_display_key(item),
        item_title=item.title,
        item_status=board_status_label(project, item.status),
        item_priority=item.priority,
        item_due_at=item.due_at.isoformat() if item.due_at else None,
        assignee_name=assignee_name(db, item),
    )


def assignee_name(db: Session, item: LoopItem) -> str | None:
    """The member who owns the item right now, when a person owns it."""

    if not item.assignee_user_id:
        return None
    user = db.get(User, item.assignee_user_id)
    return user.user_name if user is not None else None


def board_status_label(project: CloudProject, status: str | None) -> str | None:
    """The board column name a status id maps to, when the board knows it."""

    if not status:
        return None
    for status_id, name in project_board_statuses(project):
        if status_id == status:
            return name or status
    return status


def item_display_key(item: LoopItem) -> str | None:
    """The short key a board shows for the item, such as ``WEG-12``."""

    name = (item.name or "").strip()
    if name:
        return name
    identifier = (item.id or "").strip()
    return identifier if re.fullmatch(r"[A-Za-z][A-Za-z0-9]*-\d+", identifier) else None
