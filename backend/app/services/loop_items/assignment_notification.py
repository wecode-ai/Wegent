"""Create an inbox entry in the assignment transaction."""

from sqlalchemy.orm import Session

from app.services.notification_copy import assignment_copy
from app.services.wework_notifications import create_notification


def notify_project_task_assignee(
    db: Session,
    *,
    user_id: int,
    actor_user_id: int,
    project_id: str,
    project_name: str,
    item_id: str,
    item_title: str,
    assigner_name: str,
) -> None:
    copy = assignment_copy(
        assigner_name=assigner_name,
        item_title=item_title,
        project_name=project_name,
    )
    create_notification(
        db,
        user_id=user_id,
        actor_user_id=actor_user_id,
        kind="assignment",
        title=copy.title,
        body=copy.body,
        project_id=project_id,
        item_id=item_id,
        payload={
            "projectId": project_id,
            "projectName": project_name,
            "itemId": item_id,
            "itemTitle": item_title,
            "assignerName": assigner_name,
        },
    )
