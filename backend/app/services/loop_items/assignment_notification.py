"""Create an inbox entry in the assignment transaction."""

from sqlalchemy.orm import Session

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
    create_notification(
        db,
        user_id=user_id,
        actor_user_id=actor_user_id,
        kind="assignment",
        title="看板任务分配",
        body=f"{assigner_name} 将「{project_name}」看板的「{item_title}」分配给了你",
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
