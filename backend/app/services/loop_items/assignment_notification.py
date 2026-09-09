"""Create an inbox entry in the assignment transaction."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.services.wework_notifications import create_notification


def notify_human_assignment(db: Session, *, issue: LoopItem, workflow: dict) -> None:
    from urllib.parse import quote

    from app.models.delivery import CloudProject
    from app.services.loop_item_unread import advance_content_revision
    from app.services.wework_notifications import issue_url

    assignment = workflow["assignment"]
    issue.metadata_json = advance_content_revision(issue.metadata_json)
    project = db.get(CloudProject, issue.cloud_project_id)
    instruction = (
        workflow.get("current_work")
        or assignment.get("decision", {}).get("instruction")
        or ""
    )
    url = f"{issue_url(str(issue.cloud_project_id), str(issue.id))}/assignments/{quote(assignment['id'], safe='')}"
    create_notification(
        db,
        user_id=assignment["assignee_user_id"],
        actor_user_id=int(
            workflow.get("coordinator_user_id") or issue.created_by_user_id
        ),
        kind="assignment",
        title=f"待你处理：{issue.title}"[:256],
        body=f"请回复工单「{issue.title}」：\n{instruction[:1000]}\n\n确认处理完成后，点击“继续推进”交回 AI。",
        url=url,
        payload={
            "projectId": str(issue.cloud_project_id),
            "projectName": project.name,
            "itemId": str(issue.id),
            "itemTitle": issue.title,
            "assignerName": "AI",
            "assignmentId": assignment["id"],
            "instruction": instruction,
            "url": url,
        },
    )


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
