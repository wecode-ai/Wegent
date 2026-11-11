"""Plan group message account locks before any actor or wakeup account lock."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CollaborationChatGroup
from app.models.user import User
from app.schemas.project_chat import ProjectChatMention
from app.services.chat_group_access import chat_group_member_grants
from app.services.collaboration_container_access import (
    get_collaboration_container,
    lock_scoped_thread,
)


def mentioned_user_ids(mentions: list[ProjectChatMention]) -> set[int]:
    return {
        int(mention.id)
        for mention in mentions
        if mention.type == "user"
        and mention.id.isascii()
        and mention.id.isdecimal()
        and 0 < int(mention.id) <= 2**31 - 1
    }


def prepare_group_message_authority(
    db: Session,
    *,
    group_id: str,
    thread_id: str | None,
    actor_user_id: int,
) -> None:
    """Keep legacy projects unchanged; authorization still follows this planning step."""
    if not isinstance(
        get_collaboration_container(db, group_id), CollaborationChatGroup
    ):
        return
    db.query(CollaborationChatGroup).filter_by(
        id=group_id
    ).with_for_update().populate_existing().one()
    group_grants = chat_group_member_grants(db, group_id, lock=True)
    if actor_user_id not in group_grants:
        raise HTTPException(404, "Chat group not found")
    actor_active = False
    # A participation range lock before these account locks can deadlock with
    # another group's assignment-index insertion under MySQL repeatable-read.
    # Lock current granted accounts first, including muted implicit reply targets.
    for user_id in sorted(group_grants):
        user = (
            db.query(User)
            .filter(User.id == user_id)
            .with_for_update()
            .populate_existing()
            .one_or_none()
        )
        if user_id == actor_user_id:
            actor_active = user is not None and user.is_active
    if not actor_active:
        raise HTTPException(404, "Chat group not found")
    if thread_id is not None:
        lock_scoped_thread(db, group_id, thread_id)
