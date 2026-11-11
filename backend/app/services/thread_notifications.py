"""Thread notification subscriptions never grant group reading or execution."""

from sqlalchemy.orm import Session

from app.models.delivery import (
    CollaborationChatGroup,
    LoopItem,
    ThreadParticipant,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.services.chat_group_access import chat_group_members
from app.services.collaboration_container_access import get_collaboration_container
from app.services.notification_copy import (
    comment_preview,
    mention_message,
    thread_message,
)
from app.services.notification_target import board_notification_target
from app.services.wework_notifications import create_notification


def thread_notification_recipients(
    db: Session, thread: LoopItem, *, lock: bool = False
) -> set[int]:
    group = db.get(CollaborationChatGroup, str(thread.cloud_project_id))
    if (
        group is None
        or group.status not in {"active", "archived"}
        or not loop_datetime_value_is_unset(group.deleted_at)
        or thread.resource_type != "task"
        or not loop_datetime_value_is_unset(thread.deleted_at)
    ):
        return set()
    participants = db.query(ThreadParticipant).filter(
        ThreadParticipant.parent_id == thread.id,
        ThreadParticipant.status == "active",
        loop_datetime_is_unset(ThreadParticipant.deleted_at),
    )
    if lock:
        participants = (
            participants.order_by(ThreadParticipant.id)
            .with_for_update()
            .populate_existing()
        )
    eligible = {
        row.user_id
        for row in participants
        if isinstance(row.metadata_json, dict)
        and row.metadata_json.get("notifications", "all") == "all"
    }
    members = {
        int(row["user_id"])
        for row in chat_group_members(db, group.id, lock=lock, user_ids=eligible)
    }
    return eligible & members


def group_notification_readable(db: Session, user_id: int, payload: dict) -> bool:
    """Historical inbox content still requires current group read authority."""
    container_id = payload.get("groupId") or payload.get("projectId")
    if not container_id:
        return True
    group = get_collaboration_container(db, str(container_id))
    if not isinstance(group, CollaborationChatGroup):
        return not payload.get("groupId")
    from app.services.chat_group_access import chat_group_role

    if chat_group_role(db, group.id, user_id) is None:
        return False
    thread_id = payload.get("itemId")
    if not thread_id:
        return True
    thread = db.get(LoopItem, str(thread_id))
    return (
        thread is not None
        and thread.resource_type == "task"
        and str(thread.cloud_project_id) == str(group.id)
        and loop_datetime_value_is_unset(thread.deleted_at)
    )


def group_notification_allowed(db: Session, user_id: int, payload: dict) -> bool:
    """Recheck delayed delivery after membership or subscription changes."""
    container_id = payload.get("groupId") or payload.get("projectId")
    if not container_id:
        return True
    if not group_notification_readable(db, user_id, payload):
        return False
    group = get_collaboration_container(db, str(container_id))
    if not isinstance(group, CollaborationChatGroup) or not payload.get("itemId"):
        return True
    thread = db.get(LoopItem, str(payload["itemId"]))
    return thread is not None and user_id in thread_notification_recipients(db, thread)


def notify_thread_message(
    db: Session,
    *,
    group: CollaborationChatGroup,
    thread: LoopItem,
    comment_id: str,
    actor_user_id: int,
    actor_name: str,
    content: str,
    mentioned_ids: set[int],
    reply_preview: str | None,
) -> None:
    """Append one inbox record per subscribed reader in the message transaction."""
    target = board_notification_target(db, group, thread)
    preview = comment_preview(content)
    ordinary = thread_message(
        actor_name=actor_name, preview=preview, comment_id=comment_id, target=target
    )
    for recipient_id in sorted(
        thread_notification_recipients(db, thread, lock=True) - {actor_user_id}
    ):
        message = (
            mention_message(
                actor_name=actor_name,
                preview=preview,
                comment_id=comment_id,
                target=target,
                reply_preview=reply_preview,
            )
            if recipient_id in mentioned_ids
            else ordinary
        )
        create_notification(
            db,
            user_id=recipient_id,
            actor_user_id=actor_user_id,
            kind=message.kind,
            title=message.title,
            body=message.body,
            project_id=str(group.id),
            item_id=str(thread.id),
            comment_id=message.comment_id,
            payload=message.payload,
        )
