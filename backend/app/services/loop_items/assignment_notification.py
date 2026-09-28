"""Create an inbox entry in the assignment transaction."""

from sqlalchemy.orm import Session

from app.services.notification_copy import NotificationTarget, assignment_message
from app.services.wework_notifications import create_notification


def notify_project_task_assignee(
    db: Session,
    *,
    user_id: int,
    actor_user_id: int,
    target: NotificationTarget,
    assigner_name: str,
) -> None:
    message = assignment_message(assigner_name=assigner_name, target=target)
    create_notification(
        db,
        user_id=user_id,
        actor_user_id=actor_user_id,
        kind=message.kind,
        title=message.title,
        body=message.body,
        project_id=target.project_id,
        item_id=target.item_id,
        payload=message.payload,
    )
