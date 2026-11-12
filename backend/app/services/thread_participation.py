# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Current Thread participation; visibility continues to come from its group."""

import hashlib

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    CollaborationChatGroup,
    LoopItem,
    LoopItemComment,
    ThreadParticipant,
    loop_datetime_is_unset,
)
from app.models.project_chat_message import ProjectChatMessage


def join_thread(db: Session, thread: LoopItem, user_id: int) -> None:
    """The caller holds the Thread row lock or has just inserted the Thread."""
    from app.services.chat_group_access import chat_group_role

    if chat_group_role(db, thread.cloud_project_id, user_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Not a group member")
    key = participant_id(str(thread.id), user_id)
    row = db.get(ThreadParticipant, key)
    if row is None:
        row = ThreadParticipant(
            id=key,
            parent_id=thread.id,
            user_id=user_id,
            status="active",
            metadata_json={"notifications": "all"},
        )
        db.add(row)
    elif row.parent_id == thread.id and row.user_id == user_id:
        row.status = "active"
    else:
        raise HTTPException(status.HTTP_409_CONFLICT, "Participant identity collision")


def historical_participant_ids(
    db: Session, thread: LoopItem, *, source_container_id: str
) -> set[int]:
    """Collect persisted human facts in the original scope, without granting access."""
    candidates = {
        value for value in (thread.created_by_user_id, thread.assignee_user_id) if value
    }
    comments = db.query(LoopItemComment).filter(
        LoopItemComment.loop_item_id == thread.id,
        LoopItemComment.cloud_project_id == source_container_id,
        loop_datetime_is_unset(LoopItemComment.deleted_at),
    )
    for comment in comments:
        # Normal discussion has no operation event_type. Unknown events are not
        # evidence of discussion and must not silently subscribe their actors.
        metadata = comment.metadata_json
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError(f"Invalid discussion metadata on comment {comment.id}")
        metadata = metadata or {}
        if (
            (comment.description or "").strip()
            and metadata.get("event_type") is None
            and comment.created_by_user_id
        ):
            candidates.add(comment.created_by_user_id)
    messages = db.query(
        ProjectChatMessage.sender_id, ProjectChatMessage.content
    ).filter(
        ProjectChatMessage.project_id == source_container_id,
        ProjectChatMessage.task_id == thread.id,
        ProjectChatMessage.sender_type == "user",
        ProjectChatMessage.message_type == "text",
        loop_datetime_is_unset(ProjectChatMessage.deleted_at),
    )
    for sender_id, content in messages:
        if content.strip() and sender_id.isascii() and sender_id.isdecimal():
            user_id = int(sender_id)
            if 0 < user_id <= 2**31 - 1 and str(user_id) == sender_id:
                candidates.add(user_id)
    return candidates


def initialize_historical_participants(
    db: Session, thread: LoopItem, *, source_container_id: str
) -> list[int]:
    """Commit source facts with migration, preserving existing left/muted choices."""
    from app.services.chat_group_access import chat_group_members

    if db.get(CollaborationChatGroup, str(thread.cloud_project_id)) is None:
        raise ValueError("Historical participation requires a migrated Thread")
    candidates = historical_participant_ids(
        db, thread, source_container_id=source_container_id
    )
    eligible = {
        member["user_id"] for member in chat_group_members(db, thread.cloud_project_id)
    }
    created = []
    for user_id in sorted(candidates & eligible):
        key = participant_id(str(thread.id), user_id)
        existing = db.get(ThreadParticipant, key)
        if existing is not None:
            if existing.parent_id != thread.id or existing.user_id != user_id:
                raise ValueError("Participant identity collision")
            continue
        join_thread(db, thread, user_id)
        created.append(user_id)
    db.flush()
    return created


def initialize_thread_participants(db: Session, thread: LoopItem) -> None:
    """New Threads include only the creator and explicitly assigned human."""
    if db.get(CollaborationChatGroup, str(thread.cloud_project_id)) is None:
        return
    for user_id in sorted(
        {
            value
            for value in (thread.created_by_user_id, thread.assignee_user_id)
            if value
        }
    ):
        join_thread(db, thread, user_id)


def participant_id(thread_id: str, user_id: int) -> str:
    """Use a stable key so simultaneous joins cannot create two memberships."""
    value = hashlib.sha256(f"thread:{thread_id}:user:{user_id}".encode()).digest()
    return str(int.from_bytes(value[:8], "big") & ((1 << 63) - 1))


def is_participant(
    db: Session, thread_id: str, user_id: int, *, lock: bool = False
) -> bool:
    query = db.query(ThreadParticipant.id).filter(
        ThreadParticipant.id == participant_id(thread_id, user_id),
        ThreadParticipant.parent_id == thread_id,
        ThreadParticipant.user_id == user_id,
        ThreadParticipant.status == "active",
        loop_datetime_is_unset(ThreadParticipant.deleted_at),
    )
    if lock:
        query = query.with_for_update()
    return query.first() is not None


def require_thread_participation(
    db: Session, thread: LoopItem, user_id: int, *, execute: bool = False
) -> None:
    """Legacy project Issues retain their existing action authorization."""
    group = db.get(CollaborationChatGroup, str(thread.cloud_project_id))
    if group is not None and not is_participant(db, str(thread.id), user_id, lock=True):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Join the Thread before participating"
        )
    if (
        group is not None
        and execute
        and thread.status in {"completed", "cancelled", "archived"}
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Reopen the Thread before executing"
        )
