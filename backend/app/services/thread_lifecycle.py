# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Only Thread lifecycle facts are projected into the owning group timeline."""

import hashlib

from sqlalchemy.orm import Session

from app.models.delivery import CollaborationChatGroup, LoopItem
from app.models.project_chat_message import ProjectChatMessage, project_chat_message_key
from app.models.user import User


def record_thread_lifecycle(
    db: Session, thread: LoopItem, actor_id: int, event: str
) -> None:
    if db.get(CollaborationChatGroup, str(thread.cloud_project_id)) is None:
        return
    key = hashlib.sha256(
        f"thread-lifecycle:{thread.id}:{thread.version}:{event}".encode()
    ).hexdigest()
    if db.query(ProjectChatMessage.id).filter_by(message_id=key).first():
        return
    actor = db.get(User, actor_id)
    message = ProjectChatMessage(
        message_id=key,
        project_id=str(thread.cloud_project_id),
        task_id="",
        sender_type="system",
        sender_id=str(actor_id),
        sender_name=actor.user_name if actor else "",
        message_type="thread_lifecycle",
        content=str(thread.title or ""),
        metadata_json={
            "event_type": event,
            "thread_id": str(thread.id),
            "thread_status": thread.status,
            "thread_version": thread.version,
        },
        runtime_activity_key=project_chat_message_key(key),
    )
    db.add(message)
    db.flush()
    from app.services.project_chat.push import queue_project_chat_after_commit
    from app.services.project_chat.service import project_chat_service

    queue_project_chat_after_commit(
        db,
        project_chat_service.to_view(message, db=db).model_dump(
            by_alias=True, mode="json"
        ),
    )
