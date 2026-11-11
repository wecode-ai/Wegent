"""Dispatch inbox notifications for project members mentioned in a comment."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, CollaborationChatGroup, LoopItem
from app.schemas.project_chat import ProjectChatMention
from app.services.cloud_project_visibility import project_participant_ids
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.loop_items.access import can_view_item
from app.services.notification_copy import (
    NotificationTarget,
    comment_preview,
    mention_message,
)
from app.services.notification_target import board_notification_target
from app.services.wework_notifications import create_notification


def notify_project_chat_mentions(
    db: Session,
    *,
    project: CloudProject | CollaborationChatGroup,
    task_id: str | None,
    item: LoopItem | None,
    comment_id: str,
    actor_user_id: int,
    actor_name: str,
    content: str,
    mentions: list[ProjectChatMention],
    reply_preview: str | None = None,
) -> None:
    """Notify every mentioned project member inside the comment transaction.

    Agent mentions are ignored here because they trigger an execution instead.
    Inbox rows are only appended to the session; delivery is scheduled by the
    notification service after the comment and its notifications commit.
    """

    member_ids = None
    if isinstance(project, CollaborationChatGroup):
        from app.services.chat_group_access import chat_group_members
        from app.services.project_chat.group_message_authority import mentioned_user_ids

        member_ids = {
            int(row["user_id"])
            for row in chat_group_members(
                db, project.id, lock=True, user_ids=mentioned_user_ids(mentions)
            )
        }

    if isinstance(project, CollaborationChatGroup) and task_id and item is not None:
        from app.services.thread_notifications import notify_thread_message

        notify_thread_message(
            db,
            group=project,
            thread=item,
            comment_id=comment_id,
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            content=content,
            mentioned_ids=set(_mentioned_member_ids(mentions, member_ids)),
            reply_preview=reply_preview,
        )
        return
    if not mentions:
        return
    recipient_ids = [
        user_id
        for user_id in _mentioned_member_ids(
            mentions,
            (
                member_ids
                if member_ids is not None
                else project_participant_ids(db, project)
            ),
        )
        if user_id != actor_user_id
    ]
    if not recipient_ids:
        return
    targets = [
        _authorized_mention_target(db, project, task_id, item, recipient_id)
        for recipient_id in recipient_ids
    ]

    preview = comment_preview(content)
    target = targets[0]
    message = mention_message(
        actor_name=actor_name,
        preview=preview,
        comment_id=comment_id,
        target=target,
        reply_preview=reply_preview,
    )
    for recipient_id in recipient_ids:
        create_notification(
            db,
            user_id=recipient_id,
            actor_user_id=actor_user_id,
            kind=message.kind,
            title=message.title,
            body=message.body,
            project_id=str(project.id),
            item_id=target.item_id,
            comment_id=message.comment_id,
            payload=message.payload,
        )


def _authorized_mention_target(
    db: Session,
    project: CloudProject,
    task_id: str | None,
    item: LoopItem | None,
    recipient_id: int,
) -> NotificationTarget:
    """Resolve the owning provider's target after checking recipient access."""

    if task_id is None:
        return board_notification_target(db, project, None)
    if project.task_provider in {"github", "gitlab"}:
        from app.services.loop_items.external_provider import (
            external_loop_item_provider,
        )

        try:
            return external_loop_item_provider.get_notification_target(
                db, task_id, recipient_id
            )
        except HTTPException as exc:
            if exc.status_code in {403, 404}:
                raise HTTPException(
                    422, "Mentioned user cannot view this issue"
                ) from exc
            raise
    access = require_collaboration_container_access(db, int(project.id), recipient_id)
    if item is None or not can_view_item(db, access, item, recipient_id):
        raise HTTPException(422, "Mentioned user cannot view this issue")
    return board_notification_target(db, project, item)


def _mentioned_member_ids(
    mentions: list[ProjectChatMention],
    member_ids: set[int],
) -> list[int]:
    """Return unique mentioned member ids, rejecting non-members."""

    recipient_ids: list[int] = []
    seen: set[int] = set()
    for mention in mentions:
        if mention.type != "user":
            continue
        user_id = _mentioned_user_id(mention, member_ids)
        if user_id in seen:
            continue
        seen.add(user_id)
        recipient_ids.append(user_id)
    return recipient_ids


def _mentioned_user_id(
    mention: ProjectChatMention,
    member_ids: set[int],
) -> int:
    try:
        user_id = int(mention.id)
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, "Mentioned user is invalid") from exc
    if user_id not in member_ids:
        raise HTTPException(422, "Mentioned user is not a project member")
    return user_id
