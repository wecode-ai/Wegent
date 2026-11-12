"""Current group read authority determines every realtime publication audience."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.models.delivery import (
    CloudProject,
    CollaborationChatGroup,
    LoopItem,
    loop_datetime_value_is_unset,
)
from app.services.chat_group_access import chat_group_members, chat_group_role
from app.services.collaboration_container_access import get_collaboration_container


def subscription_room(
    db: Session, container_id: str, thread_id: str | None, user_id: int
) -> str | None:
    """Called after the chat service authorizes the exact history scope."""
    from app.api.ws.wework_runtime_namespace import project_chat_room

    container = get_collaboration_container(db, container_id)
    if isinstance(container, CollaborationChatGroup):
        if chat_group_role(db, container_id, user_id) is None:
            raise HTTPException(404, "Chat group not found")
        return None
    if not isinstance(container, CloudProject):
        raise HTTPException(404, "Project not found")
    return project_chat_room(container_id, thread_id)


def publication_rooms(
    db: Session, container_id: str, thread_id: str | None
) -> list[str]:
    from app.api.ws.wework_runtime_namespace import (
        project_chat_room,
        wework_runtime_user_room,
    )

    container = get_collaboration_container(db, container_id)
    if (
        container is None
        or not loop_datetime_value_is_unset(container.deleted_at)
        or container.status not in {"active", "archived"}
    ):
        return []
    if isinstance(container, CloudProject):
        return [project_chat_room(container_id, thread_id)]
    if thread_id:
        thread = db.get(LoopItem, thread_id)
        if (
            thread is None
            or thread.resource_type != "task"
            or str(thread.cloud_project_id) != str(container_id)
            or not loop_datetime_value_is_unset(thread.deleted_at)
        ):
            return []
    return [
        wework_runtime_user_room(int(member["user_id"]))
        for member in chat_group_members(db, container_id)
    ]


def publication_rooms_for_message(message: dict[str, Any]) -> list[str]:
    """Use a fresh committed read, including from post-commit callbacks."""
    with get_db_session() as db:
        return publication_rooms(
            db,
            str(message["projectId"]),
            str(message["taskId"]) if message.get("taskId") else None,
        )
