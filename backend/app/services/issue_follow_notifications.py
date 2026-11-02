"""Deliver Issue updates to followers who can still read the Issue."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, loop_datetime_value_is_unset
from app.models.issue_follower import IssueFollower
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_items.access import can_view_item
from app.services.notification_copy import comment_preview
from app.services.notification_target import board_notification_target
from app.services.wework_notifications import create_notification


def issue_assignee(item: LoopItem) -> tuple[object, ...]:
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    group = metadata.get("collaboration_group")
    group_id = group.get("id") if isinstance(group, dict) else None
    return (
        item.assignee_user_id or None,
        item.assignee_agent_id or None,
        item.assignee_team_id or None,
        group_id,
    )


def can_receive_follow_notification(db: Session, item_id: str, user_id: int) -> bool:
    """Recheck subscription and visibility before an asynchronous delivery."""
    if db.get(IssueFollower, (item_id, user_id)) is None:
        return False
    item = db.get(LoopItem, item_id)
    if item is None or not loop_datetime_value_is_unset(item.deleted_at):
        return False
    project = db.get(CloudProject, item.cloud_project_id)
    if project is None:
        return False
    try:
        if project.task_provider in {"github", "gitlab"}:
            from app.services.loop_items.external_provider import (
                external_loop_item_provider,
            )

            external_loop_item_provider.get_notification_target(db, item_id, user_id)
            return True
        access = require_cloud_project_role(db, int(project.id), user_id)
        return can_view_item(db, access, item, user_id)
    except HTTPException as exc:
        if exc.status_code in {403, 404}:
            return False
        raise


def notify_issue_followers(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    actor_user_id: int,
    event: str,
    comment_id: str | None = None,
    content: str = "",
) -> None:
    # Match subscription writes: lock the Issue before its follower rows.
    # Comment transactions may update Issue metadata after creating notifications.
    db.query(LoopItem.id).filter(LoopItem.id == item.id).with_for_update().first()
    followers = (
        db.query(IssueFollower.user_id)
        .filter(IssueFollower.issue_id == item.id)
        .with_for_update()
    )
    for (recipient_id,) in followers:
        try:
            if project.task_provider in {"github", "gitlab"}:
                from app.services.loop_items.external_provider import (
                    external_loop_item_provider,
                )

                target = external_loop_item_provider.get_notification_target(
                    db, item.id, recipient_id
                )
            else:
                access = require_cloud_project_role(db, int(project.id), recipient_id)
                if not can_view_item(db, access, item, recipient_id):
                    continue
                target = board_notification_target(db, project, item)
        except HTTPException as exc:
            if exc.status_code in {403, 404}:
                continue
            raise
        title = {
            "comment": "关注的 Issue 有新评论",
            "status": "关注的 Issue 状态已变更",
            "assignee": "关注的 Issue 负责人已变更",
        }[event]
        create_notification(
            db,
            user_id=recipient_id,
            actor_user_id=actor_user_id,
            kind="issue_follow",
            title=title,
            body=comment_preview(content) if content else (target.item_title or ""),
            project_id=str(project.id),
            item_id=item.id,
            comment_id=comment_id,
            payload={**target.payload(), "event": event},
        )
