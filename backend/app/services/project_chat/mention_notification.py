"""Dispatch inbox notifications for project members mentioned in a comment."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.project_chat import ProjectChatMention
from app.services.notification_copy import comment_preview, mention_message
from app.services.notification_target import board_notification_target
from app.services.wework_notifications import create_notification


def notify_project_chat_mentions(
    db: Session,
    *,
    project: CloudProject,
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

    if not mentions:
        return
    member_ids = _project_member_ids(db, project)
    if not member_ids:
        return

    preview = comment_preview(content)
    target = board_notification_target(db, project, item)
    message = mention_message(
        actor_name=actor_name,
        preview=preview,
        comment_id=comment_id,
        target=target,
        reply_preview=reply_preview,
    )
    for recipient_id in _mentioned_member_ids(mentions, member_ids):
        if recipient_id == actor_user_id:
            continue
        create_notification(
            db,
            user_id=recipient_id,
            actor_user_id=actor_user_id,
            kind=message.kind,
            title=message.title,
            body=message.body,
            project_id=str(project.id),
            item_id=item.id if item is not None else None,
            comment_id=message.comment_id,
            payload=message.payload,
        )


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


def _project_member_ids(db: Session, project: CloudProject) -> set[int]:
    """Return approved project members without re-authorizing an acting user."""

    rows = (
        db.query(ResourceMember.user_id)
        .filter(
            ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
            ResourceMember.resource_id == int(project.id),
            ResourceMember.entity_type == "user",
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )
    member_ids = {int(user_id) for (user_id,) in rows}
    if project.created_by_user_id:
        member_ids.add(int(project.created_by_user_id))
    return member_ids
