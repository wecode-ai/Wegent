"""Dispatch inbox notifications for project members mentioned in a comment."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.project_chat import ProjectChatMention
from app.services.wework_notifications import create_notification

MENTION_KIND = "mention"
COMMENT_PREVIEW_MAX_CHARS = 200


def notify_project_chat_mentions(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem | None,
    actor_user_id: int,
    actor_name: str,
    content: str,
    mentions: list[ProjectChatMention],
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

    preview = _comment_preview(content)
    for recipient_id in _mentioned_member_ids(mentions, member_ids):
        if recipient_id == actor_user_id:
            continue
        create_notification(
            db,
            user_id=recipient_id,
            actor_user_id=actor_user_id,
            kind=MENTION_KIND,
            title=f"{actor_name} 在评论中提到了你",
            body=f"{preview}\n\n—— {actor_name}",
            project_id=str(project.id),
            item_id=item.id if item is not None else None,
            payload={
                "projectId": str(project.id),
                "projectName": project.name,
                "itemId": item.id if item is not None else None,
                "itemTitle": item.title if item is not None else None,
                "actorName": actor_name,
                "commentPreview": preview,
            },
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


def _comment_preview(content: str) -> str:
    collapsed = " ".join(content.split())
    if len(collapsed) <= COMMENT_PREVIEW_MAX_CHARS:
        return collapsed
    return f"{collapsed[: COMMENT_PREVIEW_MAX_CHARS - 1]}…"
