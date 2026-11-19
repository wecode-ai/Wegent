"""Persist individual public messages with Issue activity semantics."""

import hashlib

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import ProjectChatMessageView
from app.services.loop_item_unread import advance_content_revision
from app.services.project_chat.message_provenance import shared_project_chat_message
from app.services.project_chat.service import project_chat_service


def public_reply_key(
    project_id: str, item_id: str, device_id: str, task_id: str, message_id: str
) -> str:
    parts = (project_id, item_id, device_id, task_id, message_id)
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


def public_reply_view(db: Session, row: ProjectChatMessage) -> ProjectChatMessageView:
    view = project_chat_service.to_view(row, db=db)
    return ProjectChatMessageView.model_validate(
        shared_project_chat_message(view.model_dump(mode="json", by_alias=True))
    )


def existing_public_reply(
    db: Session, *, sender_id: str, key: str, body: str
) -> ProjectChatMessage | None:
    row = (
        db.query(ProjectChatMessage)
        .filter_by(sender_type="agent", sender_id=sender_id, client_message_id=key)
        .first()
    )
    if row is not None and row.content != body:
        raise HTTPException(
            409, "The public message identity already has different content"
        )
    return row


def save_public_reply(
    db: Session, *, item: LoopItem, row: ProjectChatMessage, item_metadata: dict
) -> ProjectChatMessageView:
    db.add(row)
    item.metadata_json = advance_content_revision(item_metadata)
    item.version += 1
    project_chat_service._queue_loop_item_change(db, item)
    project_chat_service._commit(db)
    db.refresh(row)
    return public_reply_view(db, row)
