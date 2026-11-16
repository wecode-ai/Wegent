"""Project public stand-in messages onto Issue comments without redispatching them."""

import hashlib
import uuid

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.issue_activity_comment import StandInPublicReply
from app.schemas.project_chat import ProjectChatMessageView
from app.services.device.identity import resolve_owned_device_alias
from app.services.loop_item_unread import advance_content_revision
from app.services.loop_items.task_bindings import active_task_binding_query
from app.services.project_chat.service import project_chat_service
from shared.telemetry.decorators import trace_sync


def stand_in_reply_recipient(db: Session, message_id: str) -> dict | None:
    row = (
        db.query(ProjectChatMessage)
        .filter_by(message_id=message_id, sender_type="agent")
        .first()
    )
    identity = (row.metadata_json or {}).get("stand_in") if row else None
    if not isinstance(identity, dict) or not isinstance(identity.get("user_id"), int):
        return None
    return {
        "user_id": identity["user_id"],
        "role_id": identity["role_id"],
        "name": row.sender_name,
    }


@trace_sync("stand_in.public_issue_reply", tracer_name="backend.project_chat")
def publish_stand_in_reply(
    db: Session,
    *,
    user_id: int,
    project_id: str,
    item_id: str,
    body: str,
    identity: StandInPublicReply,
) -> ProjectChatMessageView:
    project_chat_service._require_scope(
        db,
        user_id=user_id,
        project_id=project_id,
        task_id=item_id,
        required_role=BaseRole.Developer,
    )
    # Serialize with reassignment and other public replies on the owning Issue.
    if (
        resolve_owned_device_alias(db, user_id=user_id, device_id=identity.device_id)
        is None
    ):
        raise HTTPException(409, "The stand-in device is no longer active")
    item = (
        db.query(LoopItem)
        .filter_by(id=item_id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    bindings = active_task_binding_query(
        db,
        user_id=user_id,
        project_id=project_id,
        item_id=item_id,
        device_id=identity.device_id,
        task_id=identity.task_id,
        lock=True,
    ).all()
    if not bindings:
        raise HTTPException(409, "The stand-in has no owned Issue session binding")
    sender = (
        f"stand-in:{user_id}:{hashlib.sha256(identity.role_id.encode()).hexdigest()}"
    )
    client = hashlib.sha256(
        f"{project_id}\0{item_id}\0{identity.device_id}\0{identity.task_id}\0{identity.message_id}".encode()
    ).hexdigest()
    existing = (
        db.query(ProjectChatMessage)
        .filter_by(
            sender_type="agent",
            sender_id=sender,
            client_message_id=client,
        )
        .first()
    )
    if existing is not None:
        if existing.content != body:
            raise HTTPException(
                409, "The public message identity already has different content"
            )
        return project_chat_service.to_view(existing, db=db)
    message_id = str(uuid.uuid4())
    row = ProjectChatMessage(
        message_id=message_id,
        client_message_id=client,
        project_id=project_id,
        task_id=item_id,
        sender_type="agent",
        sender_id=sender,
        sender_name=identity.role_name,
        message_type="text",
        content=body,
        metadata_json={
            "execution_dispatch": "comment_only",
            "stand_in": {
                "user_id": user_id,
                "role_id": identity.role_id,
                "message_id": identity.message_id,
            },
        },
        status="completed",
        thread_root_message_id=message_id,
    )
    db.add(row)
    item.metadata_json = advance_content_revision(item.metadata_json)
    item.version += 1
    project_chat_service._queue_loop_item_change(db, item)
    project_chat_service._commit(db)
    db.refresh(row)
    return project_chat_service.to_view(row, db=db)
